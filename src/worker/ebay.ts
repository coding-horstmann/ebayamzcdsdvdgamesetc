/**
 * eBay Browse API Client
 * --------------------------------------------------------------------
 * - OAuth2 Client Credentials (Token wird gecacht bis 5min vor Ablauf)
 * - Browse API: item_summary/search
 * - Conservative Rate Limiting: EBAY_API_DELAY_MS zwischen Calls
 * - Exponentieller Backoff bei 429 über `applyRateLimitBackoff()`
 */

const OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const RATE_LIMIT_URL = "https://api.ebay.com/developer/analytics/v1_beta/rate_limit/";
const REQUEST_TIMEOUT_MS = 15_000;

export type EbayConditionCategory = "NEW" | "USED";
export type EbayBuyingOption = "FIXED_PRICE" | "AUCTION";

export type EbayHit = {
  price: number;
  shipping: number;
  itemWebUrl: string | null;
  imageUrl: string | null;
  /** Kategorisierung für UI/DB: "NEW" bei Condition 1000/1500, sonst "USED". */
  condition: EbayConditionCategory;
  /** Angebotsart: Sofortkauf oder Auktion. */
  buyingOption: EbayBuyingOption;
  /** Original-Condition-Text von eBay (z.B. "Neu", "Gebraucht", "Sehr gut") */
  conditionText: string | null;
  /** Numerische eBay-Condition-ID (1000, 1500, 3000, 4000, 5000) */
  conditionId: number | null;
  endTime: string | null;
  bidCount: number | null;
};

/**
 * Welche eBay-Condition-IDs MediaScout akzeptiert:
 *   1000 – New
 *   1500 – New other (see details)
 *   3000 – Used
 *   4000 – Very Good
 *   5000 – Good
 * Explizit ausgeschlossen:
 *   2000 / 2500 – Refurbished
 *   6000        – Acceptable
 */
export const EBAY_ACCEPTED_CONDITION_IDS = [1000, 1500, 3000, 4000, 5000] as const;
const ACCEPTED_SET = new Set<number>(EBAY_ACCEPTED_CONDITION_IDS);
const NEW_CONDITION_IDS = new Set<number>([1000, 1500]);

type EbayTokenResponse = {
  access_token: string;
  expires_in: number; // seconds
  token_type: string;
};

type EbayItemSummary = {
  itemId?: string;
  price?: { value?: string; currency?: string };
  currentBidPrice?: { value?: string; currency?: string };
  shippingOptions?: Array<{
    shippingCost?: { value?: string; currency?: string };
    shippingCostType?: string;
  }>;
  itemWebUrl?: string;
  image?: { imageUrl?: string };
  thumbnailImages?: Array<{ imageUrl?: string }>;
  condition?: string;
  conditionId?: string | number;
  buyingOptions?: Array<string>;
  itemEndDate?: string;
  bidCount?: number;
};

type EbaySearchResponse = {
  itemSummaries?: EbayItemSummary[];
  total?: number;
};

type EbayRateLimitRate = {
  count?: number;
  limit?: number;
  remaining?: number;
  reset?: string;
  timeWindow?: number;
};

type EbayRateLimitResource = {
  name?: string;
  rates?: EbayRateLimitRate[];
};

type EbayRateLimitApi = {
  apiContext?: string;
  apiName?: string;
  apiVersion?: string;
  resources?: EbayRateLimitResource[];
};

type EbayRateLimitResponse = {
  rateLimits?: EbayRateLimitApi[];
};

export type EbayBrowseRateLimit = {
  count: number;
  limit: number;
  remaining: number;
  reset: string;
  timeWindow: number;
};

export type EbayOfferSearchResult = {
  fixed: EbayHit | null;
  auction: EbayHit | null;
};

export class EbayRateLimitError extends Error {
  constructor() {
    super("eBay rate limit (429)");
    this.name = "EbayRateLimitError";
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} fehlt in den Umgebungsvariablen.`);
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------- OAuth ----------------------------- */

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getEbayAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 5 * 60 * 1000 > now) {
    return cachedToken.value;
  }

  const clientId = requireEnv("EBAY_CLIENT_ID").trim();
  const clientSecret = requireEnv("EBAY_CLIENT_SECRET").trim();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: OAUTH_SCOPE,
  }).toString();

  // OAuth läuft selten, aber bei 504 / timeout ist ein Retry sinnvoll.
  const maxAttempts = 5;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetchWithTimeout(OAUTH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
          "User-Agent": "MediaScout-Worker/1.0",
        },
        body,
      });

      if (res.status >= 500 && res.status <= 599 && attempt < maxAttempts - 1) {
        // Bei 504 von eBay Identity CDN länger warten bevor Retry.
        await sleep(5000 * (attempt + 1));
        continue;
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`eBay OAuth Fehler ${res.status}: ${txt.slice(0, 300)}`);
      }

      const json = (await res.json()) as EbayTokenResponse;
      cachedToken = {
        value: json.access_token,
        expiresAt: Date.now() + json.expires_in * 1000,
      };
      return cachedToken.value;
    } catch (err) {
      lastErr = err;
      // Bei jedem Fehler (Netzwerk oder 5xx) den Token-Cache leeren,
      // damit beim nächsten Produkt nicht der alte hängende Request wiederverwendet wird.
      cachedToken = null;
      if (attempt < maxAttempts - 1) {
        // Bei Netzwerk-Fehlern ebenfalls exponentiell steigern.
        await sleep(5000 * (attempt + 1));
      }
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(`eBay OAuth nach ${maxAttempts} Versuchen fehlgeschlagen: ${String(lastErr)}`);
}

/* ---------------------------- Search ----------------------------- */

const BASE_DELAY_MS = Number(process.env.EBAY_API_DELAY_MS ?? "1100");
const EBAY_FETCH_RETRIES = 3;
const DEFAULT_SEARCH_LIMIT = 50;

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const SEARCH_RESULT_LIMIT = Math.min(
  200,
  Math.max(1, parseEnvInt("EBAY_SEARCH_RESULT_LIMIT", DEFAULT_SEARCH_LIMIT))
);

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = EBAY_FETCH_RETRIES
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, init);
      // 5xx sind oft transient - kurz warten und nochmal probieren.
      if (res.status >= 500 && res.status <= 599 && attempt < retries) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(300 * (attempt + 1));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Wartet die Basis-Delay zwischen zwei Requests ab.
 * Der Worker ruft diese Funktion VOR jedem Request auf.
 */
export async function ebayThrottle(): Promise<void> {
  await sleep(BASE_DELAY_MS);
}

/**
 * Exponentieller Backoff, wenn gerade 429s passieren.
 * delay = BASE_DELAY * (consecutiveRateLimits + 1)
 */
export async function applyRateLimitBackoff(consecutiveRateLimits: number): Promise<void> {
  if (consecutiveRateLimits <= 0) return;
  const delay = BASE_DELAY_MS * (consecutiveRateLimits + 1);
  await sleep(delay);
}

type SearchOpts = {
  gtin?: string;
  asin?: string;
};

type SearchAttempt = { mode: "gtin" | "q"; value: string };

function buildSearchAttempts(opts: SearchOpts): SearchAttempt[] {
  const gtin = opts.gtin?.trim();
  if (gtin && /^\d{8,14}$/.test(gtin)) return [{ mode: "q", value: gtin }];

  const asin = opts.asin?.trim();
  if (asin && /^\d{9}[\dXx]$/.test(asin)) return [{ mode: "q", value: asin }];

  return [];
}

function isBetterHit(candidate: EbayHit, current: EbayHit | null): boolean {
  if (!current) return true;
  return candidate.price + candidate.shipping < current.price + current.shipping;
}

function parseConditionId(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function itemToHit(item: EbayItemSummary, requestedBuyingOption: EbayBuyingOption): EbayHit | null {
  if (!item.buyingOptions?.includes(requestedBuyingOption)) return null;

  const conditionId = parseConditionId(item.conditionId);
  // Zusätzliche Absicherung: eBay sollte das per Filter gar nicht liefern,
  // aber falls doch, lieber verwerfen.
  if (conditionId !== null && !ACCEPTED_SET.has(conditionId)) return null;

  const priceStr =
    requestedBuyingOption === "AUCTION"
      ? item.currentBidPrice?.value ?? item.price?.value
      : item.price?.value;
  if (!priceStr) return null;
  const price = Number.parseFloat(priceStr);
  if (!Number.isFinite(price)) return null;

  let shipping = 0;
  const shipCost = item.shippingOptions?.[0]?.shippingCost?.value;
  if (shipCost) {
    const parsed = Number.parseFloat(shipCost);
    if (Number.isFinite(parsed) && parsed > 0) shipping = parsed;
  }

  const imageUrl =
    item.image?.imageUrl ?? item.thumbnailImages?.[0]?.imageUrl ?? null;

  const category: EbayConditionCategory =
    conditionId !== null && NEW_CONDITION_IDS.has(conditionId) ? "NEW" : "USED";
  const bidCount =
    typeof item.bidCount === "number" && Number.isFinite(item.bidCount)
      ? item.bidCount
      : null;

  return {
    price,
    shipping,
    itemWebUrl: item.itemWebUrl ?? null,
    imageUrl,
    condition: category,
    buyingOption: requestedBuyingOption,
    conditionText: item.condition ?? null,
    conditionId,
    endTime: requestedBuyingOption === "AUCTION" ? item.itemEndDate ?? null : null,
    bidCount,
  };
}

/**
 * Sucht das günstigste Exemplar (Neu oder Gebraucht) auf eBay.de.
 * Akzeptierte Conditions: 1000, 1500, 3000, 4000, 5000 – siehe
 * `EBAY_ACCEPTED_CONDITION_IDS`. Refurbished (2000/2500) und Acceptable (6000)
 * sind ausgeschlossen.
 *
 * Sofortkauf (FIXED_PRICE) und Auktionen (AUCTION), Versand Deutschland, sortiert nach
 * Preis + Versand aufsteigend. Gibt `null` zurück, wenn nichts Passendes da ist.
 *
 * Wirft `EbayRateLimitError` bei HTTP 429.
 */
export async function searchCheapestProduct(
  opts: SearchOpts,
  buyingOption: EbayBuyingOption = "FIXED_PRICE",
  onRequest?: () => void
): Promise<EbayHit | null> {
  const result = await searchCheapestProductOffers(opts, [buyingOption], onRequest);
  return buyingOption === "AUCTION" ? result.auction : result.fixed;
}

export async function searchCheapestProductOffers(
  opts: SearchOpts,
  buyingOptions: EbayBuyingOption[] = ["FIXED_PRICE", "AUCTION"],
  onRequest?: () => void
): Promise<EbayOfferSearchResult> {
  const token = await getEbayAccessToken();
  const marketplace = process.env.EBAY_MARKETPLACE_ID ?? "EBAY_DE";
  const options = Array.from(new Set(buyingOptions));
  if (options.length === 0) return { fixed: null, auction: null };

  const conditionFilter = EBAY_ACCEPTED_CONDITION_IDS.join("|");
  const commonParams = {
    filter: `conditionIds:{${conditionFilter}},buyingOptions:{${options.join("|")}},deliveryCountry:DE`,
    sort: "pricePlusShipping",
    limit: String(SEARCH_RESULT_LIMIT),
  };

  const attempts = buildSearchAttempts(opts);
  if (attempts.length === 0) return { fixed: null, auction: null };

  let fixed: EbayHit | null = null;
  let auction: EbayHit | null = null;

  for (const attempt of attempts) {
    const params = new URLSearchParams();
    params.set(attempt.mode, attempt.value);
    params.set("filter", commonParams.filter);
    params.set("sort", commonParams.sort);
    params.set("limit", commonParams.limit);

    const url = `${SEARCH_URL}?${params.toString()}`;
    onRequest?.();
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplace,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "MediaScout-Worker/1.0",
      },
    });

    if (res.status === 429) {
      throw new EbayRateLimitError();
    }

    if (res.status === 401) {
      cachedToken = null;
      const body = await res.text().catch(() => "");
      throw new Error(`eBay 401 Unauthorized – Token ungültig. Body: ${body.slice(0, 200)}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`eBay Browse Fehler ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as EbaySearchResponse;
    const items = json.itemSummaries ?? [];
    if (items.length === 0) continue;

    for (const item of items) {
      if (options.includes("FIXED_PRICE")) {
        const hit = itemToHit(item, "FIXED_PRICE");
        if (hit && isBetterHit(hit, fixed)) fixed = hit;
      }
      if (options.includes("AUCTION")) {
        const hit = itemToHit(item, "AUCTION");
        if (hit && isBetterHit(hit, auction)) auction = hit;
      }
    }
  }

  return { fixed, auction };
}

export async function getEbayBrowseRateLimit(): Promise<EbayBrowseRateLimit | null> {
  const token = await getEbayAccessToken();
  const res = await fetchWithRetry(RATE_LIMIT_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "MediaScout-Worker/1.0",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`eBay Analytics Fehler ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as EbayRateLimitResponse;
  for (const api of json.rateLimits ?? []) {
    const apiContext = api.apiContext?.trim().toLowerCase();
    const apiName = api.apiName?.trim().toLowerCase();
    if (apiContext !== "buy" || apiName !== "browse") continue;

    for (const resource of api.resources ?? []) {
      if (resource.name !== "buy.browse") continue;
      const daily = (resource.rates ?? []).find(
        (rate) => rate.timeWindow === 86400 && rate.limit !== undefined
      );
      if (!daily) continue;

      return {
        count: daily.count ?? 0,
        limit: daily.limit ?? 0,
        remaining: daily.remaining ?? 0,
        reset: daily.reset ?? "",
        timeWindow: daily.timeWindow ?? 0,
      };
    }
  }

  return null;
}

/**
 * @deprecated Compatibility with the book scanner naming.
 */
export const searchCheapestBook = searchCheapestProduct;
export const searchCheapestBookOffers = searchCheapestProductOffers;
export const searchCheapestUsed = searchCheapestProduct;
