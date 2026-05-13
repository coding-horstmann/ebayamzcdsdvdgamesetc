"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ProductRow from "./ProductRow";
import type { Filters } from "./FilterPanel";
import type { ProductRow as ProductRowType } from "../../../lib/db";

type ApiResponse = {
  products: ProductRowType[];
  total: number;
  page: number;
  pageSize: number;
  error?: string;
};

export default function ProductTable({ filters }: { filters: Filters }) {
  const [products, setProducts] = useState<ProductRowType[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtersKey = useMemo(
    () =>
      `${filters.minProfit}|${filters.minRoi}|${filters.maxBsr}|${filters.minSales}|${filters.productType}|${filters.buyingOption}|${filters.sortBy}`,
    [filters]
  );

  const fetchPage = useCallback(
    async (pageToLoad: number, append: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          minProfit: String(filters.minProfit),
          minRoi: String(filters.minRoi),
          maxBsr: String(filters.maxBsr),
          minSales: String(filters.minSales),
          productType: filters.productType,
          buyingOption: filters.buyingOption,
          sortBy: filters.sortBy,
          page: String(pageToLoad),
        });
        const res = await fetch(`/api/products?${params.toString()}`, {
          cache: "no-store",
        });
        const json = (await res.json()) as ApiResponse;
        if (!res.ok) {
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        setTotal(json.total);
        setProducts((prev) => (append ? [...prev, ...json.products] : json.products));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unbekannter Fehler");
      } finally {
        setLoading(false);
      }
    },
    [filters]
  );

  // Bei Filterwechsel: zurück auf Seite 0, frisch laden.
  useEffect(() => {
    setPage(0);
    fetchPage(0, false);
  }, [filtersKey, fetchPage]);

  const canLoadMore = products.length < total;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm text-slate-600">
        <span>
          {total.toLocaleString("de-DE")} passende Produkte – angezeigt{" "}
          {products.length.toLocaleString("de-DE")}
        </span>
        {loading && <span className="text-slate-400">Lade…</span>}
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Fehler: {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Bilder</th>
              <th className="px-3 py-2 text-left">Titel</th>
              <th className="bg-slate-100 px-3 py-2 text-right text-slate-600">Amazon</th>
              <th className="bg-emerald-50 px-3 py-2 text-right text-emerald-700">Festpreis</th>
              <th className="bg-violet-50 px-3 py-2 text-right text-violet-700">Auktion</th>
              <th className="px-3 py-2 text-right">Bester Profit</th>
              <th className="px-3 py-2 text-right">Bester ROI</th>
              <th className="px-3 py-2 text-right">BSR</th>
              <th className="px-3 py-2 text-right">Verkäufe/Mon.</th>
              <th className="px-3 py-2 text-right">Geprüft</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {products.map((p) => (
              <ProductRow key={p.id} product={p} buyingOption={filters.buyingOption} />
            ))}
            {!loading && products.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-8 text-center text-slate-500">
                  Keine Produkte gefunden. Filter anpassen oder Worker laufen lassen.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {canLoadMore && (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              const next = page + 1;
              setPage(next);
              fetchPage(next, true);
            }}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60"
          >
            {loading ? "Lade…" : "Mehr laden"}
          </button>
        </div>
      )}
    </div>
  );
}
