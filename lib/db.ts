import pg from "pg";

const { Pool, types } = pg;

types.setTypeParser(20, (value) => Number.parseInt(value, 10));
types.setTypeParser(1700, (value) => Number.parseFloat(value));

export type ProductType =
  | "BOARD_GAME"
  | "CD"
  | "DVD"
  | "GAME"
  | "FIGURE"
  | "PUZZLE"
  | "VINYL"
  | "MODEL_KIT";

export type ProductRow = {
  id: number;
  asin: string;
  product_type: ProductType;
  product_code: string | null;
  title: string | null;
  brand: string | null;
  manufacturer: string | null;
  product_group: string | null;
  image_amazon: string | null;
  image_ebay: string | null;
  amazon_price: number | null;
  ebay_price: number | null;
  ebay_shipping: number | null;
  ebay_url: string | null;
  ebay_condition: "NEW" | "USED" | null;
  ebay_buying_option: "FIXED_PRICE" | "AUCTION" | null;
  ebay_fixed_price: number | null;
  ebay_fixed_shipping: number | null;
  ebay_fixed_url: string | null;
  ebay_fixed_image: string | null;
  ebay_fixed_condition: "NEW" | "USED" | null;
  ebay_fixed_last_checked: string | null;
  ebay_auction_price: number | null;
  ebay_auction_shipping: number | null;
  ebay_auction_url: string | null;
  ebay_auction_image: string | null;
  ebay_auction_condition: "NEW" | "USED" | null;
  ebay_auction_end_time: string | null;
  ebay_auction_bid_count: number | null;
  ebay_auction_last_checked: string | null;
  bsr: number | null;
  monthly_sales: number | null;
  profit_euro: number | null;
  roi_pct: number | null;
  fixed_profit_euro: number | null;
  fixed_roi_pct: number | null;
  auction_profit_euro: number | null;
  auction_roi_pct: number | null;
  last_checked: string | null;
  created_at: string | null;
};

export type WorkerRunRow = {
  id: number;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number | null;
  status: "running" | "done" | "done_with_warnings" | "aborted" | "error";
  bsr_from: number | null;
  bsr_to: number | null;
  bsr_target: number | null;
  run_limit: number | null;
  keepa_upserts: number;
  scanned: number;
  fixed_hits: number;
  auction_hits: number;
  deals: number;
  ebay_searches: number;
  ebay_rate_limits: number;
  ebay_errors: number;
  gc_stale: number;
  gc_missing_price: number;
  error_messages: string[];
  created_at: string;
};

export type ProductInsert = {
  asin: string;
  product_type: ProductType;
  product_code?: string | null;
  title?: string | null;
  brand?: string | null;
  manufacturer?: string | null;
  product_group?: string | null;
  image_amazon?: string | null;
  image_ebay?: string | null;
  amazon_price?: number | null;
  ebay_price?: number | null;
  ebay_shipping?: number | null;
  ebay_url?: string | null;
  ebay_condition?: "NEW" | "USED" | null;
  ebay_buying_option?: "FIXED_PRICE" | "AUCTION" | null;
  ebay_fixed_price?: number | null;
  ebay_fixed_shipping?: number | null;
  ebay_fixed_url?: string | null;
  ebay_fixed_image?: string | null;
  ebay_fixed_condition?: "NEW" | "USED" | null;
  ebay_fixed_last_checked?: string | null;
  ebay_auction_price?: number | null;
  ebay_auction_shipping?: number | null;
  ebay_auction_url?: string | null;
  ebay_auction_image?: string | null;
  ebay_auction_condition?: "NEW" | "USED" | null;
  ebay_auction_end_time?: string | null;
  ebay_auction_bid_count?: number | null;
  ebay_auction_last_checked?: string | null;
  bsr?: number | null;
  monthly_sales?: number | null;
  last_checked?: string | null;
  created_at?: string | null;
};
export type ProductUpdate = Partial<ProductInsert>;

let pool: pg.Pool | null = null;

function getSslConfig(connectionString: string) {
  if (
    connectionString.includes("localhost") ||
    connectionString.includes("127.0.0.1") ||
    process.env.PGSSLMODE === "disable"
  ) {
    return false;
  }
  return { rejectUnauthorized: false };
}

export function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL fehlt in den Umgebungsvariablen.");
  }

  pool = new Pool({
    connectionString,
    ssl: getSslConfig(connectionString),
    max: Number(process.env.PG_POOL_MAX ?? "5"),
  });
  return pool;
}

export async function queryRows<T extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await queryRows<T>(text, params);
  return rows[0] ?? null;
}

export async function execute(
  text: string,
  params: unknown[] = []
): Promise<{ rowCount: number }> {
  const result = await getPool().query(text, params);
  return { rowCount: result.rowCount ?? 0 };
}
