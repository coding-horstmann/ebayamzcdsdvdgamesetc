/**
 * Rolling sync helpers.
 * --------------------------------------------------------------------
 * - Upserts Keepa products into Railway Postgres.
 * - Selects fresh and backlog products for the next eBay refresh.
 * - Stores current fixed-price and auction results per product.
 * - Stores compact worker-run history for the admin dashboard.
 */

import {
  execute,
  queryOne,
  queryRows,
  type ProductInsert,
  type ProductRow,
  type ProductType,
  type ProductUpdate,
  type WorkerRunRow,
} from "../../lib/db";
import type { KeepaProduct } from "./keepa";

const PRODUCT_RETENTION_DAYS = 30;
const WORKER_RUN_RETENTION_DAYS = 90;
const BACKLOG_PAGE_SIZE = 1000;

type KeepaBsrCursor = {
  next_bsr_from?: number;
};

export type EbayDbHit = {
  price: number;
  shipping: number;
  itemWebUrl: string | null;
  imageUrl: string | null;
  condition: "NEW" | "USED";
  buyingOption: "FIXED_PRICE" | "AUCTION";
  endTime?: string | null;
  bidCount?: number | null;
};

function cursorKey(productType: ProductType): string {
  return `keepa_bsr_cursor_${productType.toLowerCase()}`;
}

export async function upsertProductsFromKeepa(products: KeepaProduct[]): Promise<number> {
  if (products.length === 0) return 0;

  const rows: ProductInsert[] = products.map((p) => ({
    asin: p.asin,
    product_type: p.product_type,
    product_code: p.product_code,
    title: p.title,
    brand: p.brand,
    manufacturer: p.manufacturer,
    product_group: p.product_group,
    image_amazon: p.image_amazon,
    amazon_price: p.amazon_price,
    bsr: p.bsr,
    monthly_sales: p.monthly_sales,
  }));

  const columns: Array<keyof ProductInsert> = [
    "asin",
    "product_type",
    "product_code",
    "title",
    "brand",
    "manufacturer",
    "product_group",
    "image_amazon",
    "amazon_price",
    "bsr",
    "monthly_sales",
  ];
  const updateColumns = columns.filter((column) => column !== "asin");
  const CHUNK = 500;
  let total = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const values = chunk
      .map((row, rowIndex) => {
        const start = rowIndex * columns.length;
        columns.forEach((column) => params.push(row[column] ?? null));
        return `(${columns.map((_, colIndex) => `$${start + colIndex + 1}`).join(", ")})`;
      })
      .join(", ");

    const sql = `
      insert into products (${columns.join(", ")})
      values ${values}
      on conflict (asin) do update set
        ${updateColumns.map((column) => `${column} = excluded.${column}`).join(", ")};
    `;

    try {
      const result = await execute(sql, params);
      total += result.rowCount;
    } catch (err) {
      console.error(
        "[Sync] Upsert-Fehler:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return total;
}

function normalizeBsrCursor(value: unknown, maxBsr: number): number {
  if (!value || typeof value !== "object") return 1;
  const next = (value as KeepaBsrCursor).next_bsr_from;
  if (typeof next !== "number" || !Number.isFinite(next)) return 1;
  if (next < 1 || next > maxBsr) return 1;
  return Math.floor(next);
}

function workerStateError(errorMessage: string): Error {
  return new Error(
    `[Sync] worker_state fehlt oder ist nicht lesbar: ${errorMessage}. ` +
      "Bitte database/schema.sql auf der Railway-Postgres-Datenbank ausfuehren."
  );
}

export async function getNextKeepaBsr(
  productType: ProductType,
  maxBsr: number
): Promise<number> {
  try {
    const row = await queryOne<{ value: unknown }>(
      "select value from worker_state where key = $1",
      [cursorKey(productType)]
    );
    return normalizeBsrCursor(row?.value, maxBsr);
  } catch (err) {
    throw workerStateError(err instanceof Error ? err.message : String(err));
  }
}

export async function setNextKeepaBsr(
  productType: ProductType,
  nextBsrFrom: number,
  maxBsr: number
): Promise<void> {
  const next = nextBsrFrom < 1 || nextBsrFrom > maxBsr ? 1 : Math.floor(nextBsrFrom);
  try {
    await execute(
      `
        insert into worker_state (key, value, updated_at)
        values ($1, $2::jsonb, now())
        on conflict (key) do update set
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      [cursorKey(productType), JSON.stringify({ next_bsr_from: next })]
    );
  } catch (err) {
    throw workerStateError(err instanceof Error ? err.message : String(err));
  }
}

export async function countProductsUpToBsr(
  productType: ProductType,
  maxBsr: number
): Promise<number> {
  try {
    const row = await queryOne<{ count: number }>(
      `
        select count(*)::int as count
        from products
        where product_type = $1
          and bsr is not null
          and bsr <= $2
      `,
      [productType, maxBsr]
    );
    return row?.count ?? 0;
  } catch (err) {
    console.error(
      "[Sync] BSR-Count konnte nicht gelesen werden:",
      err instanceof Error ? err.message : String(err)
    );
    return 0;
  }
}

export async function selectProductsByAsins(
  asins: string[],
  limit: number
): Promise<ProductRow[]> {
  const uniqueAsins = Array.from(new Set(asins.filter(Boolean)));
  if (uniqueAsins.length === 0 || limit <= 0) return [];

  try {
    return await queryRows<ProductRow>(
      `
        select *
        from products
        where asin = any($1::text[])
        order by bsr asc nulls last, id asc
        limit $2
      `,
      [uniqueAsins, limit]
    );
  } catch (err) {
    console.error(
      "[Sync] Batch-Auswahl fuer eBay fehlgeschlagen:",
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

export async function selectEbayBacklog(
  limit: number,
  excludeAsins: string[] = [],
  maxBsr: number
): Promise<ProductRow[]> {
  if (limit <= 0) return [];
  const excluded = Array.from(new Set(excludeAsins.filter(Boolean)));
  const rows: ProductRow[] = [];

  for (let offset = 0; rows.length < limit; offset += BACKLOG_PAGE_SIZE) {
    try {
      const page = await queryRows<ProductRow>(
        `
          select *
          from products
          where product_code is not null
            and bsr is not null
            and bsr <= $1
            and not (asin = any($2::text[]))
          order by last_checked asc nulls first, bsr asc nulls last, id asc
          limit $3 offset $4
        `,
        [maxBsr, excluded, BACKLOG_PAGE_SIZE, offset]
      );

      if (page.length === 0) break;
      rows.push(...page);
      if (page.length < BACKLOG_PAGE_SIZE) break;
    } catch (err) {
      console.error(
        "[Sync] Backlog-Auswahl fuer eBay fehlgeschlagen:",
        err instanceof Error ? err.message : String(err)
      );
      break;
    }
  }

  return rows.slice(0, limit);
}

function hitTotal(hit: EbayDbHit): number {
  return hit.price + hit.shipping;
}

function pickBestHit(hits: Array<EbayDbHit | null | undefined>): EbayDbHit | null {
  const available = hits.filter((hit): hit is EbayDbHit => Boolean(hit));
  if (available.length === 0) return null;
  return available.sort((a, b) => hitTotal(a) - hitTotal(b))[0];
}

async function updateProductPatch(id: number, patch: ProductUpdate): Promise<void> {
  const entries = Object.entries(patch);
  if (entries.length === 0) return;

  const setSql = entries.map(([column], index) => `${column} = $${index + 1}`).join(", ");
  const params = entries.map(([, value]) => value);
  params.push(id);

  try {
    await execute(`update products set ${setSql} where id = $${params.length}`, params);
  } catch (err) {
    console.error(
      `[Sync] Update id=${id} fehlgeschlagen:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

export async function updateEbayForProduct(
  id: number,
  hits: {
    fixed?: EbayDbHit | null;
    auction?: EbayDbHit | null;
  }
): Promise<void> {
  const checkedAt = new Date().toISOString();
  const patch: ProductUpdate = {
    last_checked: checkedAt,
  };

  if (hits.fixed !== undefined) {
    if (hits.fixed) {
      patch.ebay_fixed_price = hits.fixed.price;
      patch.ebay_fixed_shipping = hits.fixed.shipping;
      patch.ebay_fixed_url = hits.fixed.itemWebUrl;
      patch.ebay_fixed_image = hits.fixed.imageUrl;
      patch.ebay_fixed_condition = hits.fixed.condition;
    } else {
      patch.ebay_fixed_price = null;
      patch.ebay_fixed_shipping = null;
      patch.ebay_fixed_url = null;
      patch.ebay_fixed_image = null;
      patch.ebay_fixed_condition = null;
    }
    patch.ebay_fixed_last_checked = checkedAt;
  }

  if (hits.auction !== undefined) {
    if (hits.auction) {
      patch.ebay_auction_price = hits.auction.price;
      patch.ebay_auction_shipping = hits.auction.shipping;
      patch.ebay_auction_url = hits.auction.itemWebUrl;
      patch.ebay_auction_image = hits.auction.imageUrl;
      patch.ebay_auction_condition = hits.auction.condition;
      patch.ebay_auction_end_time = hits.auction.endTime ?? null;
      patch.ebay_auction_bid_count = hits.auction.bidCount ?? null;
    } else {
      patch.ebay_auction_price = null;
      patch.ebay_auction_shipping = null;
      patch.ebay_auction_url = null;
      patch.ebay_auction_image = null;
      patch.ebay_auction_condition = null;
      patch.ebay_auction_end_time = null;
      patch.ebay_auction_bid_count = null;
    }
    patch.ebay_auction_last_checked = checkedAt;
  }

  const bestHit = pickBestHit([hits.fixed, hits.auction]);
  if (hits.fixed !== undefined || hits.auction !== undefined) {
    if (bestHit) {
      patch.ebay_price = bestHit.price;
      patch.ebay_shipping = bestHit.shipping;
      patch.ebay_url = bestHit.itemWebUrl;
      patch.image_ebay = bestHit.imageUrl;
      patch.ebay_condition = bestHit.condition;
      patch.ebay_buying_option = bestHit.buyingOption;
    } else if (hits.fixed !== undefined && hits.auction !== undefined) {
      patch.ebay_price = null;
      patch.ebay_shipping = null;
      patch.ebay_url = null;
      patch.ebay_condition = null;
      patch.ebay_buying_option = null;
    }
  }

  await updateProductPatch(id, patch);
}

export async function createWorkerRun(input: {
  startedAt: string;
  bsrTarget: number;
  runLimit: number;
}): Promise<number | null> {
  try {
    const row = await queryOne<{ id: number }>(
      `
        insert into worker_runs (started_at, status, bsr_target, run_limit)
        values ($1, 'running', $2, $3)
        returning id
      `,
      [input.startedAt, input.bsrTarget, input.runLimit]
    );
    return row?.id ?? null;
  } catch (err) {
    console.error(
      "[WorkerRuns] Start konnte nicht gespeichert werden:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

export async function finishWorkerRun(
  id: number | null,
  patch: Partial<Omit<WorkerRunRow, "id" | "created_at">>
): Promise<void> {
  if (id === null) return;

  const entries = Object.entries(patch);
  if (entries.length === 0) return;
  const setSql = entries.map(([column], index) => `${column} = $${index + 1}`).join(", ");
  const params = entries.map(([, value]) => value);
  params.push(id);

  try {
    await execute(`update worker_runs set ${setSql} where id = $${params.length}`, params);
  } catch (err) {
    console.error(
      `[WorkerRuns] Update id=${id} fehlgeschlagen:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

export async function listRecentWorkerRuns(limit = 10): Promise<WorkerRunRow[]> {
  try {
    return await queryRows<WorkerRunRow>(
      "select * from worker_runs order by started_at desc limit $1",
      [limit]
    );
  } catch (err) {
    console.error(
      "[WorkerRuns] Liste konnte nicht gelesen werden:",
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

export async function pruneWorkerRuns(): Promise<number> {
  const staleBefore = new Date(
    Date.now() - WORKER_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  try {
    const result = await execute("delete from worker_runs where started_at < $1", [staleBefore]);
    return result.rowCount;
  } catch (err) {
    console.error(
      "[WorkerRuns] Altes Log konnte nicht geloescht werden:",
      err instanceof Error ? err.message : String(err)
    );
    return 0;
  }
}

export async function garbageCollect(): Promise<{ stale: number; missingPrice: number }> {
  const staleBefore = new Date(
    Date.now() - PRODUCT_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  let stale = 0;
  let missingPrice = 0;

  try {
    const result = await execute(
      "delete from products where last_checked is not null and last_checked < $1",
      [staleBefore]
    );
    stale = result.rowCount;
  } catch (err) {
    console.error("[GC] Stale-Delete-Fehler:", err instanceof Error ? err.message : String(err));
  }

  try {
    const result = await execute("delete from products where amazon_price is null");
    missingPrice = result.rowCount;
  } catch (err) {
    console.error(
      "[GC] MissingPrice-Delete-Fehler:",
      err instanceof Error ? err.message : String(err)
    );
  }

  return { stale, missingPrice };
}
