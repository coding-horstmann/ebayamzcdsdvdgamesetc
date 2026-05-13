/**
 * MediaScout DE worker.
 * --------------------------------------------------------------------
 * 1) Keepa sync: find physical products with GTIN/EAN/UPC per category.
 * 2) eBay scan: refresh fixed-price and auction results per product.
 * 3) Cleanup and compact run history.
 */

import { keepaFetchProducts, keepaFindAsins } from "./keepa";
import {
  applyRateLimitBackoff,
  EbayRateLimitError,
  ebayThrottle,
  getEbayBrowseRateLimit,
  searchCheapestProductOffers,
  type EbayHit,
} from "./ebay";
import {
  countProductsUpToBsr,
  createWorkerRun,
  finishWorkerRun,
  garbageCollect,
  getNextKeepaBsr,
  pruneWorkerRuns,
  selectEbayBacklog,
  selectProductsByAsins,
  setNextKeepaBsr,
  updateEbayForProduct,
  upsertProductsFromKeepa,
} from "./sync";
import {
  getBsrTargetPerCategory,
  getProductCategories,
  type ProductCategory,
} from "./categories";
import { ensureDatabase } from "../../lib/migrate";

const MAX_CONSECUTIVE_RATE_LIMITS = 5;
const DEFAULT_KEEPA_BSR_WINDOW = 3000;
const MAX_KEEPA_FINDER_RESULTS_PER_BLOCK = 10000;
const DEFAULT_EBAY_DAILY_CALL_RESERVE = 200;
const DEFAULT_EBAY_FALLBACK_SCAN_LIMIT = 1000;

function parseEnvNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseEnvBoolean(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  if (["1", "true", "yes", "ja", "on"].includes(v)) return true;
  if (["0", "false", "no", "nein", "off"].includes(v)) return false;
  return fallback;
}

type LogFn = (line: string) => void;

function fmtIsoForLog(iso: string): string {
  if (!iso) return "unbekannt";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toISOString();
}

type KeepaSyncStats = {
  upserted: number;
  productAsins: string[];
  bsrFrom: number;
  bsrTo: number;
  knownProductsUpToTarget: number;
  blocks: number;
  foundAsins: number;
  fetchedProducts: number;
  searchableProducts: number;
  completedFullCycle: boolean;
  warning: string | null;
};

export type WorkerResult = {
  runId: number | null;
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
  bsrFrom: number | null;
  bsrTo: number | null;
  keepaUpserts: number;
  scanned: number;
  hits: number;
  fixedHits: number;
  auctionHits: number;
  deals: number;
  ebaySearches: number;
  ebayRateLimits: number;
  ebayErrors: number;
  aborted: boolean;
  abortReason: "rate_limit" | "quota" | "errors" | null;
  gc: { stale: number; missingPrice: number };
  warnings: string[];
  errors: string[];
};

type EbaySearchableProduct = {
  product_code?: string | null;
};

function hasEbaySearchKey(product: EbaySearchableProduct): boolean {
  const code = product.product_code?.trim();
  return Boolean(code && /^\d{8,14}$/.test(code));
}

async function runKeepaSyncForCategory(
  log: LogFn,
  category: ProductCategory,
  targetSearchableProducts: number,
  bsrTarget: number,
  bsrWindow: number
): Promise<KeepaSyncStats> {
  const minAmazonPriceEur = parseEnvNumber("MIN_AMZ_PRICE", 20);
  const firstBsrFrom = await getNextKeepaBsr(category.type, bsrTarget);
  let currentBsrFrom = firstBsrFrom;
  let lastBsrTo = firstBsrFrom;
  let remainingBsrRanks = bsrTarget;
  const knownProductsUpToTarget = await countProductsUpToBsr(category.type, bsrTarget);
  const windowSize = Math.max(1, Math.min(bsrTarget, Math.floor(bsrWindow)));
  const selectedAsins = new Set<string>();
  const productAsins: string[] = [];
  let totalUpserted = 0;
  let totalFoundAsins = 0;
  let totalFetchedProducts = 0;
  let totalSearchableProducts = 0;
  let blocks = 0;

  log(
    `[Keepa:${category.label}] Ziel: ${targetSearchableProducts} neue GTIN-Produkte, ` +
      `min Amazon ${minAmazonPriceEur} EUR, Start-BSR ${firstBsrFrom}, ` +
      `Blockgroesse ${windowSize}, Ziel-BSR ${bsrTarget}, ` +
      `gespeicherte Produkte bis Ziel ${knownProductsUpToTarget}`
  );

  while (
    targetSearchableProducts > 0 &&
    remainingBsrRanks > 0 &&
    totalSearchableProducts < targetSearchableProducts
  ) {
    const spanToTarget = bsrTarget - currentBsrFrom + 1;
    const span = Math.min(windowSize, remainingBsrRanks, spanToTarget);
    const bsrFrom = currentBsrFrom;
    const bsrTo = currentBsrFrom + span - 1;
    const stillNeeded = targetSearchableProducts - totalSearchableProducts;
    blocks++;

    log(
      `[Keepa:${category.label}] Block ${blocks}: BSR-Fenster ${bsrFrom}-${bsrTo}, ` +
        `noch ${stillNeeded} GTIN-Produkte bis Kategorie-Ziel.`
    );

    let warning: string | null = null;
    try {
      const asins = await keepaFindAsins({
        category,
        minAmazonPriceEur,
        limit: MAX_KEEPA_FINDER_RESULTS_PER_BLOCK,
        bsrFrom,
        bsrTo,
      });
      totalFoundAsins += asins.length;
      log(`[Keepa:${category.label}] Block ${blocks}: gefundene ASINs ${asins.length}`);
      if (asins.length >= MAX_KEEPA_FINDER_RESULTS_PER_BLOCK) {
        log(
          `[Keepa:${category.label}] Block ${blocks}: Finder-Limit ` +
            `${MAX_KEEPA_FINDER_RESULTS_PER_BLOCK} erreicht; kleinere KEEPA_BSR_WINDOW waere genauer.`
        );
      }

      if (asins.length > 0) {
        const products = await keepaFetchProducts(asins, {
          category,
          minAmazonPriceEur,
        });
        totalFetchedProducts += products.length;

        const maxFetchedBsr = products.reduce(
          (max, product) => (product.bsr !== null && product.bsr > max ? product.bsr : max),
          0
        );
        if (maxFetchedBsr > 0) {
          log(`[Keepa:${category.label}] Block ${blocks}: hoechster BSR ${maxFetchedBsr}`);
        }

        const searchableInBlock = products.filter(hasEbaySearchKey);
        log(
          `[Keepa:${category.label}] Block ${blocks}: gueltige Preis-Produkte ${products.length}, ` +
            `davon suchbar per GTIN ${searchableInBlock.length}`
        );

        const upserted = await upsertProductsFromKeepa(products);
        totalUpserted += upserted;
        log(`[Keepa:${category.label}] Block ${blocks}: Upserts in Postgres ${upserted}`);

        for (const product of searchableInBlock) {
          if (selectedAsins.has(product.asin)) continue;
          selectedAsins.add(product.asin);
          productAsins.push(product.asin);
        }
        totalSearchableProducts = productAsins.length;
      }
    } catch (err) {
      warning = err instanceof Error ? err.message : String(err);
      log(
        `[Keepa:${category.label}] Block ${blocks} nicht abgeschlossen: ${warning}. ` +
          "Bisherige Keepa-Ergebnisse bleiben erhalten."
      );
    }

    if (warning) {
      log(
        `[Keepa:${category.label}] Stoppe Keepa fuer diesen Lauf mit Teil-Ergebnis: ` +
          `${totalSearchableProducts}/${targetSearchableProducts} GTIN-Produkte.`
      );
      return {
        upserted: totalUpserted,
        productAsins,
        bsrFrom: firstBsrFrom,
        bsrTo: lastBsrTo,
        knownProductsUpToTarget,
        blocks: blocks - 1,
        foundAsins: totalFoundAsins,
        fetchedProducts: totalFetchedProducts,
        searchableProducts: totalSearchableProducts,
        completedFullCycle: false,
        warning,
      };
    }

    lastBsrTo = bsrTo;
    remainingBsrRanks -= span;
    currentBsrFrom = bsrTo >= bsrTarget ? 1 : bsrTo + 1;
    await setNextKeepaBsr(category.type, currentBsrFrom, bsrTarget);
    log(`[Keepa:${category.label}] Cursor gespeichert: naechster Start BSR ${currentBsrFrom}`);
  }

  if (remainingBsrRanks <= 0 && totalSearchableProducts < targetSearchableProducts) {
    log(
      `[Keepa:${category.label}] Ein kompletter BSR-Kreis bis ${bsrTarget} ist durch; ` +
        `${totalSearchableProducts}/${targetSearchableProducts} GTIN-Produkte gefunden.`
    );
  }
  log(
    `[Keepa:${category.label}] Fertig: Bloecke=${blocks}, ASINs=${totalFoundAsins}, ` +
      `Preis-Produkte=${totalFetchedProducts}, GTIN=${totalSearchableProducts}, ` +
      `Upserts=${totalUpserted}, naechster Start BSR ${currentBsrFrom}`
  );

  return {
    upserted: totalUpserted,
    productAsins,
    bsrFrom: firstBsrFrom,
    bsrTo: lastBsrTo,
    knownProductsUpToTarget,
    blocks,
    foundAsins: totalFoundAsins,
    fetchedProducts: totalFetchedProducts,
    searchableProducts: totalSearchableProducts,
    completedFullCycle: remainingBsrRanks <= 0,
    warning: null,
  };
}

type EbayScanStats = {
  scanned: number;
  hits: number;
  fixedHits: number;
  auctionHits: number;
  deals: number;
  searches: number;
  rateLimits: number;
  errors: number;
  aborted: boolean;
  abortReason: "rate_limit" | "quota" | "errors" | null;
};

function bestProfit(amazonPrice: number | null, hits: Array<EbayHit | null>): number | null {
  if (amazonPrice === null) return null;
  const profits = hits
    .filter((hit): hit is EbayHit => Boolean(hit))
    .map((hit) => amazonPrice - (hit.price + hit.shipping));
  if (profits.length === 0) return null;
  return Math.max(...profits);
}

type ProductCandidate = Awaited<ReturnType<typeof selectEbayBacklog>>[number];

async function selectSearchableEbayBacklog(
  limit: number,
  excludeAsins: string[],
  bsrTarget: number
): Promise<ProductCandidate[]> {
  if (limit <= 0) return [];

  const rows: ProductCandidate[] = [];
  const excluded = new Set(excludeAsins.filter(Boolean));

  while (rows.length < limit) {
    const remaining = limit - rows.length;
    const requestLimit = Math.max(1000, remaining * 2);
    const page = await selectEbayBacklog(requestLimit, Array.from(excluded), bsrTarget);
    if (page.length === 0) break;

    for (const row of page) {
      excluded.add(row.asin);
      if (!hasEbaySearchKey(row)) continue;
      rows.push(row);
      if (rows.length >= limit) break;
    }

    if (page.length < requestLimit) break;
  }

  return rows.slice(0, limit);
}

async function runEbayScan(
  log: LogFn,
  preferredAsins: string[],
  limit: number,
  bsrTarget: number,
  callBudget: number | null,
  fillBacklog: boolean
): Promise<EbayScanStats> {
  const candidateLimit = callBudget === null ? limit : Math.max(0, Math.min(limit, callBudget));
  const currentBatch = (await selectProductsByAsins(preferredAsins, candidateLimit))
    .filter(hasEbaySearchKey)
    .slice(0, candidateLimit);
  const remaining = Math.max(0, candidateLimit - currentBatch.length);
  const backlog = fillBacklog
    ? await selectSearchableEbayBacklog(
        remaining,
        currentBatch.map((p) => p.asin),
        bsrTarget
      )
    : [];
  const candidates = [...currentBatch, ...backlog].slice(0, candidateLimit);
  log(
    `[eBay] Scan-Kandidaten: ${candidates.length} ` +
      `(frische Keepa-Kandidaten ${currentBatch.length}, Backlog ${backlog.length}, ` +
      `Backlog-Fueller ${fillBacklog ? "an" : "aus"})`
  );
  if (candidates.length < candidateLimit) {
    log(
      `[eBay] Kandidaten unter Budget: ${candidates.length}/${candidateLimit}. ` +
        `Es sind aktuell nicht genug GTIN-Produkte bis BSR ${bsrTarget} verfuegbar.`
    );
  }

  const stats: EbayScanStats = {
    scanned: 0,
    hits: 0,
    fixedHits: 0,
    auctionHits: 0,
    deals: 0,
    searches: 0,
    rateLimits: 0,
    errors: 0,
    aborted: false,
    abortReason: null,
  };

  if (callBudget !== null) {
    log(`[eBay] Call-Budget fuer diesen Lauf: ${callBudget}`);
    if (callBudget <= 0) {
      log("[eBay] Kein nutzbares Tageskontingent uebrig - eBay-Scan wird uebersprungen.");
      stats.aborted = true;
      stats.abortReason = "quota";
      return stats;
    }
  }

  let consecutiveRateLimits = 0;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;

  const noteQuotaStop = () => {
    log(`[eBay] Tageskontingent erreicht (${stats.searches}/${callBudget} Calls) - Scan stoppt sauber.`);
    stats.aborted = true;
    stats.abortReason = "quota";
  };

  const noteError = (asin: string, err: unknown): boolean => {
    if (err instanceof EbayRateLimitError) {
      consecutiveRateLimits++;
      stats.rateLimits++;
      log(`[eBay] 429 Rate-Limit (#${consecutiveRateLimits}) bei ASIN=${asin}`);
      if (consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
        log(`[eBay] ${MAX_CONSECUTIVE_RATE_LIMITS}x hintereinander 429 - Worker wird beendet.`);
        stats.aborted = true;
        stats.abortReason = "rate_limit";
        return true;
      }
      return false;
    }

    consecutiveErrors++;
    stats.errors++;
    log(
      `[eBay] Fehler bei ASIN=${asin} (#${consecutiveErrors}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );

    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      log(
        `[eBay] ${MAX_CONSECUTIVE_ERRORS}x hintereinander Fehler (kein 429) - eBay-Scan wird abgebrochen.`
      );
      stats.aborted = true;
      stats.abortReason = "errors";
      return true;
    }
    return false;
  };

  const searchProduct = async (
    product: (typeof candidates)[number]
  ): Promise<{ fixed: EbayHit | null; auction: EbayHit | null }> => {
    if (callBudget !== null && stats.searches >= callBudget) {
      noteQuotaStop();
      return { fixed: null, auction: null };
    }

    await applyRateLimitBackoff(consecutiveRateLimits);
    await ebayThrottle();
    return searchCheapestProductOffers(
      {
        gtin: product.product_code ?? undefined,
      },
      ["FIXED_PRICE", "AUCTION"],
      () => {
        stats.searches++;
      }
    );
  };

  for (const p of candidates) {
    let fixedHit: EbayHit | null = null;
    let auctionHit: EbayHit | null = null;

    try {
      const result = await searchProduct(p);
      fixedHit = result.fixed;
      auctionHit = result.auction;
      if (stats.abortReason === "quota") return stats;
    } catch (err) {
      if (noteError(p.asin, err)) return stats;
      continue;
    }

    await updateEbayForProduct(p.id, {
      fixed: fixedHit,
      auction: auctionHit,
    });

    stats.scanned++;
    consecutiveRateLimits = 0;
    consecutiveErrors = 0;

    if (fixedHit) stats.fixedHits++;
    if (auctionHit) stats.auctionHits++;
    if (fixedHit || auctionHit) stats.hits++;

    const profit = bestProfit(p.amazon_price, [fixedHit, auctionHit]);
    if (profit !== null && profit > 3) stats.deals++;
  }

  if (callBudget !== null && stats.searches >= callBudget && limit > candidateLimit) {
    noteQuotaStop();
  }

  return stats;
}

export async function runWorker(logger?: LogFn): Promise<WorkerResult> {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  const log: LogFn = (line) => {
    console.log(line);
    if (logger) logger(line);
  };

  log(`[Worker] Start ${startedAtIso}`);
  await ensureDatabase();
  const categories = getProductCategories();
  const bsrTarget = Math.max(1, Math.floor(getBsrTargetPerCategory()));
  const keepaBsrWindow = Math.max(
    1,
    Math.floor(parseEnvNumber("KEEPA_BSR_WINDOW", DEFAULT_KEEPA_BSR_WINDOW))
  );
  const ebayReserve = Math.max(
    0,
    Math.floor(parseEnvNumber("EBAY_DAILY_CALL_RESERVE", DEFAULT_EBAY_DAILY_CALL_RESERVE))
  );
  const ebayFallbackScanLimit = Math.max(
    1,
    Math.floor(parseEnvNumber("EBAY_FALLBACK_SCAN_LIMIT", DEFAULT_EBAY_FALLBACK_SCAN_LIMIT))
  );
  const fillBacklog = parseEnvBoolean("EBAY_BACKLOG_FILL", true);

  log(
    `[Worker] Kategorien: ${categories.map((category) => category.label).join(", ")}; ` +
      `BSR-Ziel je Kategorie ${bsrTarget}`
  );
  log(`[Keepa] KEEPA_BSR_WINDOW=${keepaBsrWindow}`);
  log(`[eBay] Tagesreserve: ${ebayReserve} Calls`);

  let ebayCallBudget: number | null = null;
  let skipKeepaBecauseQuota = false;
  try {
    const quota = await getEbayBrowseRateLimit();
    if (quota) {
      ebayCallBudget = Math.max(0, quota.remaining - ebayReserve);
      log(
        `[eBay] Browse-Quota: count=${quota.count} limit=${quota.limit} ` +
          `remaining=${quota.remaining} reserve=${ebayReserve} usable=${ebayCallBudget} ` +
          `reset=${fmtIsoForLog(quota.reset)} window=${quota.timeWindow}s`
      );
      skipKeepaBecauseQuota = ebayCallBudget <= 0;
    } else {
      log("[eBay] Browse-Quota konnte in der Analytics-Antwort nicht gefunden werden.");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[eBay] Browse-Quota konnte nicht gelesen werden: ${msg}`);
  }

  const ebayScanLimit =
    ebayCallBudget === null ? ebayFallbackScanLimit : Math.max(0, ebayCallBudget);
  if (ebayCallBudget === null) {
    log(`[eBay] Kein echtes Tagesbudget verfuegbar - Fallback-Scanlimit ${ebayScanLimit}.`);
  }
  log(
    `[Worker] Zielsteuerung: eBay-Scanlimit=${ebayScanLimit}, ` +
      `Keepa sammelt pro Kategorie in BSR-Bloecken, Backlog-Fueller ${
        fillBacklog ? "an" : "aus"
      }.`
  );
  const runId = await createWorkerRun({
    startedAt: startedAtIso,
    bsrTarget,
    runLimit: ebayScanLimit,
  });

  let keepaUpserts = 0;
  const keepaProductAsins: string[] = [];
  let bsrFrom: number | null = null;
  let bsrTo: number | null = null;

  if (skipKeepaBecauseQuota) {
    log("[Keepa] Uebersprungen, weil eBay kein nutzbares Tageskontingent mehr hat.");
  } else {
    const perCategoryTarget = Math.max(1, Math.ceil(ebayScanLimit / categories.length));
    const seenAsins = new Set<string>();

    for (const category of categories) {
      try {
        const keepa = await runKeepaSyncForCategory(
          log,
          category,
          perCategoryTarget,
          bsrTarget,
          keepaBsrWindow
        );
        keepaUpserts += keepa.upserted;
        for (const asin of keepa.productAsins) {
          if (seenAsins.has(asin)) continue;
          seenAsins.add(asin);
          keepaProductAsins.push(asin);
        }
        bsrFrom = bsrFrom === null ? keepa.bsrFrom : Math.min(bsrFrom, keepa.bsrFrom);
        bsrTo = bsrTo === null ? keepa.bsrTo : Math.max(bsrTo, keepa.bsrTo);
        log(
          `[Keepa:${category.label}] Ergebnis fuer eBay: ${keepa.searchableProducts}/${perCategoryTarget} ` +
            `frische GTIN-Kandidaten aus ${keepa.blocks} Block/Bloecken.`
        );
        if (keepa.warning) {
          const warning = `Keepa-Sync Warnung (${category.label}): ${keepa.warning}`;
          warnings.push(warning);
          log(`[Worker] ${warning}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Keepa-Sync ${category.label}: ${msg}`);
        log(`[Worker] Keepa-Sync ${category.label} fehlgeschlagen: ${msg}`);
      }
    }
  }

  let stats: EbayScanStats = {
    scanned: 0,
    hits: 0,
    fixedHits: 0,
    auctionHits: 0,
    deals: 0,
    searches: 0,
    rateLimits: 0,
    errors: 0,
    aborted: false,
    abortReason: null,
  };
  try {
    stats = await runEbayScan(
      log,
      keepaProductAsins,
      ebayScanLimit,
      bsrTarget,
      ebayCallBudget,
      fillBacklog
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`eBay-Scan: ${msg}`);
    log(`[Worker] eBay-Scan fehlgeschlagen: ${msg}`);
  }

  let gc = { stale: 0, missingPrice: 0 };
  try {
    gc = await garbageCollect();
    const oldRuns = await pruneWorkerRuns();
    log(
      `[GC] geloescht: ${gc.stale} stale (>30 Tage), ${gc.missingPrice} ohne amazon_price, ` +
        `${oldRuns} alte Worker-Runs`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`GC: ${msg}`);
    log(`[Worker] Garbage Collection fehlgeschlagen: ${msg}`);
  }

  const endedAt = Date.now();
  const endedAtIso = new Date(endedAt).toISOString();
  const durationMinutes = Number(((endedAt - startedAt) / 1000 / 60).toFixed(2));
  const status = stats.aborted
    ? "aborted"
    : errors.length > 0
    ? "error"
    : warnings.length > 0
    ? "done_with_warnings"
    : "done";
  const runMessages = [...warnings, ...errors];
  if (stats.abortReason === "rate_limit") {
    runMessages.push(
      `eBay-Rate-Limit: ${MAX_CONSECUTIVE_RATE_LIMITS}x 429 in Folge; Lauf geordnet beendet.`
    );
  } else if (stats.abortReason === "quota") {
    runMessages.push("eBay-Kontingent: nutzbares Tagesbudget erreicht; Lauf geordnet beendet.");
  } else if (stats.abortReason === "errors") {
    runMessages.push("eBay-Scan: 3x Fehler in Folge; Lauf vorzeitig beendet.");
  }

  log(
    `[Worker] Fertig. keepaUpserts=${keepaUpserts} scanned=${stats.scanned} ` +
      `hits=${stats.hits} fixed=${stats.fixedHits} auctions=${stats.auctionHits} ` +
      `deals(>3 EUR)=${stats.deals} ebaySearches=${stats.searches} ` +
      `aborted=${stats.aborted} laufzeit=${durationMinutes} min`
  );

  await finishWorkerRun(runId, {
    ended_at: endedAtIso,
    duration_minutes: durationMinutes,
    status,
    bsr_from: bsrFrom,
    bsr_to: bsrTo,
    bsr_target: bsrTarget,
    run_limit: ebayScanLimit,
    keepa_upserts: keepaUpserts,
    scanned: stats.scanned,
    fixed_hits: stats.fixedHits,
    auction_hits: stats.auctionHits,
    deals: stats.deals,
    ebay_searches: stats.searches,
    ebay_rate_limits: stats.rateLimits,
    ebay_errors: stats.errors,
    gc_stale: gc.stale,
    gc_missing_price: gc.missingPrice,
    error_messages: runMessages,
  });

  return {
    runId,
    startedAt: startedAtIso,
    endedAt: endedAtIso,
    durationMinutes,
    bsrFrom,
    bsrTo,
    keepaUpserts,
    scanned: stats.scanned,
    hits: stats.hits,
    fixedHits: stats.fixedHits,
    auctionHits: stats.auctionHits,
    deals: stats.deals,
    ebaySearches: stats.searches,
    ebayRateLimits: stats.rateLimits,
    ebayErrors: stats.errors,
    aborted: stats.aborted,
    abortReason: stats.abortReason,
    gc,
    warnings,
    errors,
  };
}

const isDirect = (() => {
  try {
    return require.main === module;
  } catch {
    return false;
  }
})();

if (isDirect) {
  runWorker()
    .then((result) => {
      if (
        result.aborted &&
        result.abortReason !== "rate_limit" &&
        result.abortReason !== "quota"
      ) {
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error("[Worker] Fataler Fehler:", err);
      process.exit(1);
    });
}
