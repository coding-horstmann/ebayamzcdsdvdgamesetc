/**
 * Keepa API client for physical media and games.
 * --------------------------------------------------------------------
 * Uses Keepa Product Finder to walk the best seller ranks for:
 * Brettspiele, CDs, DVD/Blu-ray, Games, figures, puzzles, vinyl and model kits on Amazon.de.
 *
 * The book scanner was ISBN-first. For these categories we keep that same
 * precision principle by requiring a GTIN/EAN/UPC from Keepa before a product
 * becomes eligible for eBay scanning.
 */

import type { ProductType } from "../../lib/db";
import type { ProductCategory } from "./categories";

const KEEPA_BASE = "https://api.keepa.com";
const DOMAIN_DE = 3;
const NEW_INDEX = 1;
const USED_INDEX = 2;
const SALES_INDEX = 3;
const MAX_PRODUCT_BATCH_SIZE = 100;
const DEFAULT_PRODUCT_BATCH_SIZE = 10;
const DEFAULT_REFILL_RATE_PER_MINUTE = 20;
const PRODUCT_TOKEN_SAFETY_BUFFER = 2;
const TOKEN_DELAY_SAFETY_MS = 5_000;
const KEEPA_QUERY_TOKEN_ESTIMATE = 10;
const MAX_QUERY_ATTEMPTS = 4;

export type KeepaProduct = {
  asin: string;
  product_type: ProductType;
  product_code: string;
  title: string | null;
  brand: string | null;
  manufacturer: string | null;
  product_group: string | null;
  amazon_price: number | null;
  bsr: number | null;
  monthly_sales: number | null;
  image_amazon: string | null;
};

type KeepaFinderResponse = {
  asinList?: string[];
  tokensLeft?: number;
  error?: { type?: string; message?: string };
};

type KeepaProductResponse = {
  products?: KeepaRawProduct[];
  tokensLeft?: number;
  refillIn?: number;
  refillRate?: number;
  error?: { type?: string; message?: string };
};

type KeepaRateLimitResponse = {
  refillIn?: number;
  refillRate?: number;
  tokensLeft?: number;
};

type KeepaCategoryTreeEntry = {
  catId?: number;
  name?: string;
};

type KeepaRawProduct = {
  asin: string;
  title?: string | null;
  brand?: string | null;
  manufacturer?: string | null;
  imagesCSV?: string | null;
  salesRanks?: Record<string, number[]> | null;
  monthlySold?: number | null;
  stats?: {
    current?: Array<number>;
  } | null;
  eanList?: string[] | null;
  upcList?: string[] | null;
  productGroup?: string | null;
  binding?: string | null;
  format?: string | null;
  categoryTree?: KeepaCategoryTreeEntry[] | null;
};

type KeepaSelection = Record<string, unknown>;

function requireKey(): string {
  const k = process.env.KEEPA_API_KEY;
  if (!k) throw new Error("KEEPA_API_KEY fehlt.");
  return k;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function productBatchSize(): number {
  const configured = Number(process.env.KEEPA_PRODUCT_BATCH_SIZE);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.floor(configured), MAX_PRODUCT_BATCH_SIZE);
  }
  return Math.min(DEFAULT_PRODUCT_BATCH_SIZE, MAX_PRODUCT_BATCH_SIZE);
}

function parseKeepaRateLimit(body: string): KeepaRateLimitResponse | null {
  try {
    const parsed = JSON.parse(body) as KeepaRateLimitResponse;
    if (
      typeof parsed.refillIn === "number" ||
      typeof parsed.refillRate === "number" ||
      typeof parsed.tokensLeft === "number"
    ) {
      return parsed;
    }
  } catch {
    // Body was not Keepa's JSON token status payload.
  }
  return null;
}

function refillRatePerMinute(status: KeepaRateLimitResponse | null): number {
  return typeof status?.refillRate === "number" && status.refillRate > 0
    ? status.refillRate
    : DEFAULT_REFILL_RATE_PER_MINUTE;
}

function tokenSafetyBuffer(requestedTokens: number): number {
  return Math.max(PRODUCT_TOKEN_SAFETY_BUFFER, Math.ceil(requestedTokens * 0.1));
}

function tokenShortfall(status: KeepaRateLimitResponse | null, requestedTokens: number): number {
  if (requestedTokens <= 0 || typeof status?.tokensLeft !== "number") return 0;

  const safety = tokenSafetyBuffer(requestedTokens);
  return Math.max(0, requestedTokens + safety - status.tokensLeft);
}

function tokenDelayMs(status: KeepaRateLimitResponse | null, requestedTokens: number): number {
  const shortfall = tokenShortfall(status, requestedTokens);
  if (shortfall <= 0) return 0;

  return Math.ceil((shortfall / refillRatePerMinute(status)) * 60_000);
}

function keepaRateLimitDelayMs(
  status: KeepaRateLimitResponse | null,
  attempt: number,
  requestedTokens: number
): number {
  const refillDelay =
    typeof status?.refillIn === "number" && status.refillIn > 0 ? status.refillIn : 0;
  const fallbackDelay = Math.min(5_000 * attempt, 60_000);

  return (
    Math.max(refillDelay, tokenDelayMs(status, requestedTokens), fallbackDelay) +
    TOKEN_DELAY_SAFETY_MS
  );
}

function keepaProductPacingDelayMs(
  status: KeepaRateLimitResponse | null,
  nextBatchSize: number
): number {
  if (nextBatchSize <= 0 || typeof status?.tokensLeft !== "number") return 0;

  const delayMs = tokenDelayMs(status, nextBatchSize);
  return delayMs > 0 ? delayMs + TOKEN_DELAY_SAFETY_MS : 0;
}

function centsToEuro(cents: number | undefined | null): number | null {
  if (cents === undefined || cents === null) return null;
  if (cents < 0) return null;
  return Math.round(cents) / 100;
}

function extractFirstImageUrl(imagesCSV: string | null | undefined): string | null {
  if (!imagesCSV) return null;
  const first = imagesCSV.split(",")[0]?.trim();
  if (!first) return null;
  return `https://images-na.ssl-images-amazon.com/images/I/${first}`;
}

function normalizeDigits(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return /^\d{8,14}$/.test(digits) ? digits : null;
}

function pickProductCode(p: KeepaRawProduct): string | null {
  const candidates = [...(p.eanList ?? []), ...(p.upcList ?? [])];
  for (const candidate of candidates) {
    const digits = normalizeDigits(candidate);
    if (digits) return digits;
  }
  return null;
}

function pickLastRank(arr: number[] | undefined): number | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  // salesRanks format: [timestamp, rank, timestamp, rank, ...]
  for (let i = arr.length - 1; i >= 1; i -= 2) {
    const rank = arr[i];
    if (typeof rank === "number" && rank > 0) return rank;
  }
  return null;
}

function pickCategoryBsr(p: KeepaRawProduct, categoryId: number): number | null {
  const categoryRank = pickLastRank(p.salesRanks?.[String(categoryId)]);
  if (categoryRank !== null) return categoryRank;

  const fromStats = p.stats?.current?.[SALES_INDEX];
  if (typeof fromStats === "number" && fromStats > 0) return fromStats;

  if (p.salesRanks && typeof p.salesRanks === "object") {
    let lowest: number | null = null;
    for (const arr of Object.values(p.salesRanks)) {
      const rank = pickLastRank(arr);
      if (rank !== null && (lowest === null || rank < lowest)) lowest = rank;
    }
    if (lowest !== null) return lowest;
  }

  return null;
}

function categoryTreeIds(p: KeepaRawProduct): Set<number> {
  return new Set((p.categoryTree ?? []).map((item) => item.catId).filter(Boolean) as number[]);
}

function hasCategoryEvidence(p: KeepaRawProduct, categoryId: number): boolean {
  if (categoryTreeIds(p).has(categoryId)) return true;
  return Boolean(p.salesRanks?.[String(categoryId)]);
}

function textOf(p: KeepaRawProduct): string {
  return `${p.title ?? ""} ${p.brand ?? ""} ${p.manufacturer ?? ""} ${p.productGroup ?? ""} ${p.binding ?? ""} ${p.format ?? ""}`
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function containsAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function isNonPhysical(p: KeepaRawProduct): boolean {
  const text = textOf(p);
  return containsAny(text, [
    "download",
    "digital",
    "downloadcode",
    "code in a box",
    "activation code",
    "key card",
    "gutschein",
    "geschenkkarte",
    "gift card",
    "psn",
    "nintendo eshop",
    "xbox live",
    "steam code",
    "dlc",
    "add-on",
    "abo",
    "subscription",
    "punktekarte",
    "points card",
  ]);
}

function isLikelyGameHardware(p: KeepaRawProduct): boolean {
  const text = textOf(p);
  return containsAny(text, [
    "konsole",
    "console",
    "controller",
    "joy-con",
    "headset",
    "ladestation",
    "charging station",
    "lenkrad",
    "wheel",
    "case",
    "tasche",
    "schutzfolie",
    "screen protector",
    "kabel",
    "cable",
    "adapter",
    "remote",
  ]);
}

function isLikelyVinylRecord(p: KeepaRawProduct): boolean {
  const binding = (p.binding ?? "").toLowerCase();
  const format = (p.format ?? "").toLowerCase();
  const text = textOf(p);

  return (
    binding.includes("lp_record") ||
    binding.includes("vinyl") ||
    format.includes("vinyl") ||
    text.includes("[vinyl") ||
    text.includes("vinyl lp") ||
    text.includes(" lp]") ||
    text.includes("2lp") ||
    text.includes("3lp")
  );
}

function isLikelyPuzzleAccessory(p: KeepaRawProduct): boolean {
  const text = textOf(p);
  return containsAny(text, [
    "puzzle-zubehor",
    "puzzlezubehor",
    "puzzle zubehor",
    "puzzle accessory",
    "puzzlematte",
    "puzzle mat",
    "puzzlekleber",
    "puzzle glue",
    "sortierer",
    "sorting tray",
    "aufbewahrung",
    "storage",
  ]);
}

function isLikelyModelKitAccessory(p: KeepaRawProduct): boolean {
  const text = textOf(p);
  return containsAny(text, [
    "zubehor",
    "accessory",
    "werkzeug",
    "tool",
    "farbe",
    "paint",
    "kleber",
    "glue",
    "schraube",
    "screw",
    "ersatzteil",
    "spare part",
    "motor",
    "akku",
    "battery",
    "ladegerat",
    "charger",
    "servo",
    "adapter",
    "kabel",
    "cable",
    "controller",
    "fernbedienung",
    "remote",
  ]);
}

function isLikelyPhysicalCategoryProduct(p: KeepaRawProduct, category: ProductCategory): boolean {
  if (isNonPhysical(p)) return false;

  const group = (p.productGroup ?? "").toLowerCase();
  const hasCategory = hasCategoryEvidence(p, category.categoryId);

  if (category.type === "BOARD_GAME") {
    return hasCategory || group.includes("toy") || group.includes("spielzeug");
  }

  if (category.type === "CD") {
    if (isLikelyVinylRecord(p)) return false;
    return hasCategory || group.includes("music") || group.includes("musik");
  }

  if (category.type === "DVD") {
    return hasCategory || group.includes("dvd") || group.includes("video") || group.includes("movie");
  }

  if (category.type === "GAME") {
    if (isLikelyGameHardware(p)) return false;
    return (
      hasCategory ||
      group.includes("video game") ||
      group.includes("videogame") ||
      group.includes("games")
    );
  }

  if (category.type === "FIGURE") {
    return (
      hasCategory ||
      group.includes("toy") ||
      group.includes("spielzeug") ||
      containsAny(textOf(p), [
        "actionfigur",
        "action figure",
        "sammelfigur",
        "spielfigur",
        "figure",
        "figur",
        "funko",
        "amiibo",
        "nendoroid",
      ])
    );
  }

  if (category.type === "PUZZLE") {
    if (isLikelyPuzzleAccessory(p)) return false;
    return hasCategory || containsAny(textOf(p), ["puzzle", "puzzles"]);
  }

  if (category.type === "VINYL") {
    return isLikelyVinylRecord(p);
  }

  if (category.type === "MODEL_KIT") {
    if (isLikelyModelKitAccessory(p)) return false;
    return (
      hasCategory ||
      containsAny(textOf(p), [
        "modellbausatz",
        "model kit",
        "bausatz",
        "diorama",
        "standmodell",
        "modellbau",
      ])
    );
  }

  return hasCategory;
}

function categorySelections(
  category: ProductCategory,
  baseSelection: KeepaSelection
): KeepaSelection[] {
  const include = { ...baseSelection, categories_include: [category.categoryId] };
  const categoryLegacy = { ...baseSelection, category: category.categoryId };
  const root = { ...baseSelection, rootCategory: [category.categoryId] };

  return category.finderMode === "root"
    ? [root, include, categoryLegacy]
    : [include, categoryLegacy, root];
}

async function runFinderSelection(url: string): Promise<string[]> {
  for (let attempt = 1; attempt <= MAX_QUERY_ATTEMPTS; attempt++) {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");

      if (res.status === 429) {
        if (attempt === MAX_QUERY_ATTEMPTS) {
          throw new Error(`Keepa /query Fehler ${res.status}: ${body.slice(0, 300)}`);
        }

        const status = parseKeepaRateLimit(body);
        const delayMs = keepaRateLimitDelayMs(status, attempt, KEEPA_QUERY_TOKEN_ESTIMATE);
        console.warn(
          `[Keepa] /query 429; warte ${Math.ceil(delayMs / 1000)}s vor Retry ${
            attempt + 1
          }/${MAX_QUERY_ATTEMPTS}: ${body.slice(0, 200)}`
        );
        await sleep(delayMs);
        continue;
      }

      throw new Error(`Keepa /query Fehler ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as KeepaFinderResponse;
    if (json.error) {
      throw new Error(
        `Keepa /query Fehler: ${json.error.type ?? ""} ${json.error.message ?? ""}`
      );
    }

    return json.asinList ?? [];
  }

  return [];
}

export async function keepaFindAsins(opts: {
  category: ProductCategory;
  minAmazonPriceEur: number;
  limit: number;
  bsrFrom: number;
  bsrTo: number;
}): Promise<string[]> {
  const key = requireKey();
  const minCents = Math.round(opts.minAmazonPriceEur * 100);
  const bsrFrom = Math.max(1, Math.floor(opts.bsrFrom));
  const bsrTo = Math.max(bsrFrom, Math.floor(opts.bsrTo));
  const perPage = Math.min(Math.max(opts.limit, 50), 10000);
  const merged = new Set<string>();
  let lastError: Error | null = null;

  const priceFields = ["current_USED_gte", "current_NEW_gte"] as const;
  for (const priceField of priceFields) {
    const baseSelection = {
      [priceField]: minCents,
      sort: ["current_SALES", "asc"],
      current_SALES_gte: bsrFrom,
      current_SALES_lte: bsrTo,
      perPage,
      page: 0,
    };

    for (const selection of categorySelections(opts.category, baseSelection)) {
      const url =
        `${KEEPA_BASE}/query` +
        `?key=${encodeURIComponent(key)}` +
        `&domain=${DOMAIN_DE}` +
        `&selection=${encodeURIComponent(JSON.stringify(selection))}`;

      try {
        const asins = await runFinderSelection(url);
        for (const asin of asins) {
          if (asin) merged.add(asin);
          if (merged.size >= opts.limit) break;
        }
        if (merged.size > 0) break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      if (merged.size >= opts.limit) break;
    }
    if (merged.size >= opts.limit) break;
  }

  if (merged.size === 0 && lastError) throw lastError;
  return Array.from(merged).slice(0, opts.limit);
}

export async function keepaFetchProducts(
  asins: string[],
  opts: {
    category: ProductCategory;
    minAmazonPriceEur?: number;
  }
): Promise<KeepaProduct[]> {
  const key = requireKey();
  const out: KeepaProduct[] = [];
  const minAmazonPriceEur =
    typeof opts.minAmazonPriceEur === "number" && Number.isFinite(opts.minAmazonPriceEur)
      ? opts.minAmazonPriceEur
      : null;

  const BATCH = productBatchSize();
  const MAX_PRODUCT_ATTEMPTS = 6;
  if (asins.length > 0) {
    console.log(`[Keepa] /product Batch-Groesse: ${BATCH} ASINs pro Call`);
  }

  for (let i = 0; i < asins.length; i += BATCH) {
    const chunk = asins.slice(i, i + BATCH);
    const url =
      `${KEEPA_BASE}/product` +
      `?key=${encodeURIComponent(key)}` +
      `&domain=${DOMAIN_DE}` +
      `&asin=${encodeURIComponent(chunk.join(","))}` +
      `&stats=1&buybox=0&history=0`;

    let json: KeepaProductResponse | null = null;
    for (let attempt = 1; attempt <= MAX_PRODUCT_ATTEMPTS; attempt++) {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) {
        const body = await res.text().catch(() => "");

        if (res.status === 429) {
          if (attempt === MAX_PRODUCT_ATTEMPTS) {
            console.error(
              `[Keepa] /product Fehler 429 fuer Chunk ${i}-${i + chunk.length} nach ${attempt} Versuchen: ${body.slice(0, 200)}`
            );
            break;
          }

          const status = parseKeepaRateLimit(body);
          const delayMs = keepaRateLimitDelayMs(status, attempt, chunk.length);
          console.warn(
            `[Keepa] /product 429 fuer Chunk ${i}-${i + chunk.length}; warte ${Math.ceil(
              delayMs / 1000
            )}s vor Retry ${attempt + 1}/${MAX_PRODUCT_ATTEMPTS}: ${body.slice(0, 200)}`
          );
          await sleep(delayMs);
          continue;
        }

        console.error(
          `[Keepa] /product Fehler ${res.status} fuer Chunk ${i}-${i + chunk.length}: ${body.slice(0, 200)}`
        );
        break;
      }

      json = (await res.json()) as KeepaProductResponse;
      break;
    }

    if (!json) continue;
    if (json.error) {
      console.error(`[Keepa] /product Fehler: ${json.error.type} ${json.error.message}`);
      continue;
    }

    for (const p of json.products ?? []) {
      if (!isLikelyPhysicalCategoryProduct(p, opts.category)) continue;

      const productCode = pickProductCode(p);
      if (!productCode) continue;

      const usedCents = p.stats?.current?.[USED_INDEX];
      const newCents = p.stats?.current?.[NEW_INDEX];
      const usedPrice = centsToEuro(usedCents);
      const newPrice = centsToEuro(newCents);

      let amazon_price: number | null = null;
      if (usedPrice !== null && newPrice !== null) {
        amazon_price = Math.min(usedPrice, newPrice);
      } else if (usedPrice !== null) {
        amazon_price = usedPrice;
      } else if (newPrice !== null) {
        amazon_price = newPrice;
      }

      if (amazon_price === null) continue;
      if (minAmazonPriceEur !== null && amazon_price < minAmazonPriceEur) continue;

      out.push({
        asin: p.asin,
        product_type: opts.category.type,
        product_code: productCode,
        title: p.title ?? null,
        brand: p.brand ?? null,
        manufacturer: p.manufacturer ?? null,
        product_group: p.productGroup ?? null,
        amazon_price,
        bsr: pickCategoryBsr(p, opts.category.categoryId),
        monthly_sales:
          typeof p.monthlySold === "number" && p.monthlySold > 0 ? p.monthlySold : null,
        image_amazon: extractFirstImageUrl(p.imagesCSV ?? null),
      });
    }

    const nextBatchSize = Math.min(BATCH, Math.max(0, asins.length - (i + BATCH)));
    const pacingDelayMs = keepaProductPacingDelayMs(json, nextBatchSize);
    if (pacingDelayMs > 0) {
      const nextStart = i + BATCH;
      console.log(
        `[Keepa] /product Token-Pause ${Math.ceil(
          pacingDelayMs / 1000
        )}s vor Chunk ${nextStart}-${nextStart + nextBatchSize} ` +
          `(tokensLeft=${json.tokensLeft}, refillRate=${
            json.refillRate ?? DEFAULT_REFILL_RATE_PER_MINUTE
          }/min)`
      );
      await sleep(pacingDelayMs);
    }
  }

  return out;
}
