"use client";

import type { ProductRow as ProductRowType, ProductType } from "../../../lib/db";
import type { Filters } from "./FilterPanel";

function toNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtEur(v: number | string | null | undefined): string {
  const n = toNumber(v);
  if (n === null) return "-";
  return n.toLocaleString("de-DE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  });
}

function fmtInt(v: number | string | null | undefined): string {
  const n = toNumber(v);
  if (n === null) return "-";
  return n.toLocaleString("de-DE");
}

function fmtPct(v: number | string | null | undefined): string {
  const n = toNumber(v);
  if (n === null) return "-";
  return `${n.toLocaleString("de-DE", { maximumFractionDigits: 0 })}%`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "-";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "-";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return "gerade eben";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `vor ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 48) return `vor ${diffH} h`;
  const diffD = Math.round(diffH / 24);
  return `vor ${diffD} Tagen`;
}

function fmtEndTime(iso: string | null): string | null {
  if (!iso) return null;
  const end = new Date(iso);
  if (!Number.isFinite(end.getTime())) return null;
  return end.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function summaryValues(p: ProductRowType, buyingOption: Filters["buyingOption"]) {
  if (buyingOption === "fixed") {
    return {
      profit: p.fixed_profit_euro,
      roi: p.fixed_roi_pct,
      checkedAt: p.ebay_fixed_last_checked,
    };
  }
  if (buyingOption === "auction") {
    return {
      profit: p.auction_profit_euro,
      roi: p.auction_roi_pct,
      checkedAt: p.ebay_auction_last_checked,
    };
  }
  return {
    profit: p.profit_euro,
    roi: p.roi_pct,
    checkedAt: p.last_checked,
  };
}

function rowBg(p: ProductRowType, buyingOption: Filters["buyingOption"]): string {
  const summary = summaryValues(p, buyingOption);
  const profit = toNumber(summary.profit) ?? 0;
  const roi = toNumber(summary.roi) ?? 0;
  if (profit > 10 && roi > 100) return "bg-green-100";
  if (profit >= 5 && profit <= 10) return "bg-yellow-100";
  return "";
}

function valueClass(value: number | string | null | undefined, kind: "profit" | "roi"): string {
  const n = toNumber(value) ?? 0;
  if (kind === "profit") {
    if (n > 10) return "font-semibold text-green-700";
    if (n >= 5) return "font-semibold text-yellow-700";
    if (n > 0) return "text-slate-700";
    return "text-slate-400";
  }
  if (n > 100) return "font-semibold text-green-700";
  if (n >= 50) return "font-semibold text-yellow-700";
  return "text-slate-700";
}

function offerTone(label: "Festpreis" | "Auktion") {
  if (label === "Auktion") {
    return {
      cell: "border-l border-violet-200 bg-violet-50/70",
      badge: "bg-violet-100 text-violet-700",
    };
  }

  return {
    cell: "border-l border-emerald-200 bg-emerald-50/70",
    badge: "bg-emerald-100 text-emerald-700",
  };
}

function productTypeLabel(type: ProductType): string {
  if (type === "BOARD_GAME") return "Brettspiel";
  if (type === "CD") return "CD";
  if (type === "DVD") return "DVD/Blu-ray";
  if (type === "GAME") return "Game";
  return "Produkt";
}

function ConditionBadge({ condition }: { condition: "NEW" | "USED" | null }) {
  if (!condition) return null;
  return (
    <span
      className={
        condition === "NEW"
          ? "rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700"
          : "rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700"
      }
    >
      {condition === "NEW" ? "Neu" : "Gebr."}
    </span>
  );
}

function OfferCell({
  label,
  price,
  shipping,
  url,
  condition,
  profit,
  roi,
  checkedAt,
  endTime,
  bidCount,
}: {
  label: "Festpreis" | "Auktion";
  price: number | null;
  shipping: number | null;
  url: string | null;
  condition: "NEW" | "USED" | null;
  profit: number | null;
  roi: number | null;
  checkedAt: string | null;
  endTime?: string | null;
  bidCount?: number | null;
}) {
  const total = price !== null ? price + (shipping ?? 0) : null;
  const end = fmtEndTime(endTime ?? null);
  const hasBidCount = bidCount !== null && bidCount !== undefined;
  const tone = offerTone(label);

  if (price === null) {
    return (
      <td className={`min-w-48 px-3 py-3 text-right text-slate-400 ${tone.cell}`}>
        <div className={`text-xs font-semibold uppercase tracking-wide ${tone.badge}`}>
          {label}
        </div>
        <div>-</div>
        <div className="text-xs">geprüft {relativeTime(checkedAt)}</div>
      </td>
    );
  }

  return (
    <td className={`min-w-52 px-3 py-3 text-right ${tone.cell}`}>
      <div className="mb-1 flex items-center justify-end gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone.badge}`}
        >
          {label}
        </span>
        <ConditionBadge condition={condition} />
      </div>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-slate-900 underline-offset-2 hover:underline"
        >
          {fmtEur(total)}
        </a>
      ) : (
        <div className="font-medium text-slate-900">{fmtEur(total)}</div>
      )}
      {shipping && shipping > 0 ? (
        <div className="text-xs text-slate-500">inkl. {fmtEur(shipping)} Versand</div>
      ) : null}
      <div className="mt-1 text-xs">
        <span className={valueClass(profit, "profit")}>{fmtEur(profit)}</span>
        <span className="text-slate-400"> / </span>
        <span className={valueClass(roi, "roi")}>{fmtPct(roi)}</span>
      </div>
      {label === "Auktion" && (end || hasBidCount) ? (
        <div className="text-xs text-slate-500">
          {end ? `Ende ${end}` : null}
          {end && hasBidCount ? " · " : null}
          {hasBidCount ? `${fmtInt(bidCount)} Gebote` : null}
        </div>
      ) : null}
      <div className="text-xs text-slate-500">geprüft {relativeTime(checkedAt)}</div>
    </td>
  );
}

export default function ProductRow({
  product: p,
  buyingOption,
}: {
  product: ProductRowType;
  buyingOption: Filters["buyingOption"];
}) {
  const amazonUrl = `https://www.amazon.de/dp/${p.asin}`;
  const keepaChart = `https://graph.keepa.com/pricehistory.png?asin=${p.asin}&domain=3&salesrank=1&used=1&new=1&range=365`;
  const bg = rowBg(p, buyingOption);
  const image = p.ebay_fixed_image ?? p.ebay_auction_image ?? p.image_ebay ?? p.image_amazon;
  const summary = summaryValues(p, buyingOption);

  return (
    <>
      <tr className={`${bg} align-top`}>
        <td className="whitespace-nowrap px-3 py-3">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt="eBay"
              className="h-36 w-24 rounded border border-slate-200 bg-white object-contain"
              loading="lazy"
            />
          ) : null}
        </td>

        <td className="max-w-md px-3 py-3">
          <div className="font-medium text-slate-900">
            {p.title ?? <span className="text-slate-400">Kein Titel</span>}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">
              {productTypeLabel(p.product_type)}
            </span>
            {" · "}ASIN: <span className="font-mono">{p.asin}</span>
            {p.product_code && (
              <>
                {" · "}GTIN: <span className="font-mono">{p.product_code}</span>
              </>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <a
              href={amazonUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Amazon öffnen
            </a>
            {p.ebay_fixed_url ? (
              <a
                href={p.ebay_fixed_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center rounded border border-emerald-200 bg-white px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
              >
                Festpreis
              </a>
            ) : null}
            {p.ebay_auction_url ? (
              <a
                href={p.ebay_auction_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center rounded border border-violet-200 bg-white px-2 py-1 text-xs font-medium text-violet-700 hover:bg-violet-50"
              >
                Auktion
              </a>
            ) : null}
          </div>
        </td>

        <td className="whitespace-nowrap border-l border-slate-200 bg-slate-50/80 px-3 py-3 text-right">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Amazon
          </div>
          <a
            href={amazonUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-slate-900 underline-offset-2 hover:underline"
          >
            {fmtEur(p.amazon_price)}
          </a>
        </td>

        <OfferCell
          label="Festpreis"
          price={toNumber(p.ebay_fixed_price)}
          shipping={toNumber(p.ebay_fixed_shipping)}
          url={p.ebay_fixed_url}
          condition={p.ebay_fixed_condition}
          profit={toNumber(p.fixed_profit_euro)}
          roi={toNumber(p.fixed_roi_pct)}
          checkedAt={p.ebay_fixed_last_checked}
        />

        <OfferCell
          label="Auktion"
          price={toNumber(p.ebay_auction_price)}
          shipping={toNumber(p.ebay_auction_shipping)}
          url={p.ebay_auction_url}
          condition={p.ebay_auction_condition}
          profit={toNumber(p.auction_profit_euro)}
          roi={toNumber(p.auction_roi_pct)}
          checkedAt={p.ebay_auction_last_checked}
          endTime={p.ebay_auction_end_time}
          bidCount={toNumber(p.ebay_auction_bid_count)}
        />

        <td className={`whitespace-nowrap px-3 py-3 text-right ${valueClass(summary.profit, "profit")}`}>
          {fmtEur(summary.profit)}
        </td>

        <td className={`whitespace-nowrap px-3 py-3 text-right ${valueClass(summary.roi, "roi")}`}>
          {fmtPct(summary.roi)}
        </td>

        <td className="whitespace-nowrap px-3 py-3 text-right">{fmtInt(p.bsr)}</td>

        <td
          className="whitespace-nowrap px-3 py-3 text-right"
          title={p.monthly_sales ? undefined : "Keine Verkaufsdaten von Keepa verfügbar"}
        >
          {fmtInt(p.monthly_sales)}
        </td>

        <td className="whitespace-nowrap px-3 py-3 text-right text-xs text-slate-500">
          {relativeTime(summary.checkedAt)}
        </td>
      </tr>

      <tr className={`${bg}`}>
        <td colSpan={10} className="px-3 pb-4 pt-0">
          <div className="flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={keepaChart}
              alt="Keepa Chart"
              className="h-auto w-full max-w-[500px] rounded border border-slate-200 bg-white"
              loading="lazy"
            />
          </div>
        </td>
      </tr>
    </>
  );
}
