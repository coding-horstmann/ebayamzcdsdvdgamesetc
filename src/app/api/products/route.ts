import { NextRequest, NextResponse } from "next/server";
import { queryOne, queryRows, type ProductRow, type ProductType } from "../../../../lib/db";
import { ensureDatabase } from "../../../../lib/migrate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE_SIZE = 50;
const SORTS = ["best_roi", "best_profit", "bsr", "checked"] as const;
const PRODUCT_TYPES = ["BOARD_GAME", "CD", "DVD", "GAME", "FIGURE"] as const;

type BuyingOption = "all" | "fixed" | "auction";
type SortBy = (typeof SORTS)[number];
type ProductTypeFilter = "all" | ProductType;

function num(v: string | null, fallback: number): number {
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseBuyingOption(value: string | null): BuyingOption {
  return value === "fixed" || value === "auction" ? value : "all";
}

function parseSortBy(value: string | null): SortBy {
  return SORTS.includes(value as SortBy) ? (value as SortBy) : "best_roi";
}

function parseProductType(value: string | null): ProductTypeFilter {
  return PRODUCT_TYPES.includes(value as ProductType) ? (value as ProductType) : "all";
}

function sortColumn(buyingOption: BuyingOption, sortBy: SortBy): string {
  if (sortBy === "bsr") return "bsr";
  if (sortBy === "checked") {
    if (buyingOption === "fixed") return "ebay_fixed_last_checked";
    if (buyingOption === "auction") return "ebay_auction_last_checked";
    return "last_checked";
  }
  if (buyingOption === "fixed") {
    return sortBy === "best_profit" ? "fixed_profit_euro" : "fixed_roi_pct";
  }
  if (buyingOption === "auction") {
    return sortBy === "best_profit" ? "auction_profit_euro" : "auction_roi_pct";
  }
  return sortBy === "best_profit" ? "profit_euro" : "roi_pct";
}

function addParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const minProfit = num(searchParams.get("minProfit"), 5);
  const minRoi = num(searchParams.get("minRoi"), 50);
  const maxBsr = num(searchParams.get("maxBsr"), 500000);
  const minSales = num(searchParams.get("minSales"), 0);
  const productType = parseProductType(searchParams.get("productType"));
  const buyingOption = parseBuyingOption(searchParams.get("buyingOption"));
  const sortBy = parseSortBy(searchParams.get("sortBy"));
  const page = Math.max(0, Math.floor(num(searchParams.get("page"), 0)));

  const params: unknown[] = [];
  const where: string[] = [`bsr <= ${addParam(params, maxBsr)}`];

  if (productType !== "all") {
    where.push(`product_type = ${addParam(params, productType)}`);
  }
  if (minSales > 0) {
    where.push(`monthly_sales >= ${addParam(params, minSales)}`);
  }
  if (buyingOption === "auction") {
    where.push("ebay_auction_price is not null");
    where.push(`ebay_auction_condition = ${addParam(params, "NEW")}`);
    where.push("auction_profit_euro > 0");
    where.push(`auction_profit_euro >= ${addParam(params, minProfit)}`);
    where.push(`auction_roi_pct >= ${addParam(params, minRoi)}`);
  } else if (buyingOption === "fixed") {
    where.push("ebay_fixed_price is not null");
    where.push(`ebay_fixed_condition = ${addParam(params, "NEW")}`);
    where.push("fixed_profit_euro > 0");
    where.push(`fixed_profit_euro >= ${addParam(params, minProfit)}`);
    where.push(`fixed_roi_pct >= ${addParam(params, minRoi)}`);
  } else {
    where.push("ebay_price is not null");
    where.push(`ebay_condition = ${addParam(params, "NEW")}`);
    where.push("profit_euro > 0");
    where.push(`profit_euro >= ${addParam(params, minProfit)}`);
    where.push(`roi_pct >= ${addParam(params, minRoi)}`);
  }

  const whereSql = where.join(" and ");
  const orderColumn = sortColumn(buyingOption, sortBy);
  const orderDirection = sortBy === "bsr" ? "asc" : "desc";
  const limitPlaceholder = addParam(params, PAGE_SIZE);
  const offsetPlaceholder = addParam(params, page * PAGE_SIZE);

  try {
    await ensureDatabase();
    const countParams = params.slice(0, params.length - 2);
    const countRow = await queryOne<{ count: number }>(
      `select count(*)::int as count from products where ${whereSql}`,
      countParams
    );

    const products = await queryRows<ProductRow>(
      `
        select *
        from products
        where ${whereSql}
        order by ${orderColumn} ${orderDirection} nulls last, id asc
        limit ${limitPlaceholder} offset ${offsetPlaceholder}
      `,
      params
    );

    return NextResponse.json({
      products,
      total: countRow?.count ?? products.length,
      page,
      pageSize: PAGE_SIZE,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unbekannter Fehler";
    console.error("[/api/products] Fehler:", message);
    return NextResponse.json({ products: [], total: 0, error: message }, { status: 500 });
  }
}
