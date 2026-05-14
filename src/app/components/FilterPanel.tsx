"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

export type Filters = {
  minProfit: number;
  minRoi: number;
  maxBsr: number;
  minSales: number;
  productType: "all" | "BOARD_GAME" | "CD" | "DVD" | "GAME";
  buyingOption: "all" | "fixed" | "auction";
  ebayCondition: "all" | "new" | "used";
  sortBy: "best_roi" | "best_profit" | "bsr" | "checked";
};

export default function FilterPanel({ initial }: { initial: Filters }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [minProfit, setMinProfit] = useState(initial.minProfit);
  const [minRoi, setMinRoi] = useState(initial.minRoi);
  const [maxBsr, setMaxBsr] = useState(initial.maxBsr);
  const [minSales, setMinSales] = useState(initial.minSales);
  const [productType, setProductType] = useState(initial.productType);
  const [buyingOption, setBuyingOption] = useState(initial.buyingOption);
  const [ebayCondition, setEbayCondition] = useState(initial.ebayCondition);
  const [sortBy, setSortBy] = useState(initial.sortBy);

  function applyFilters(overrides: Partial<Filters> = {}) {
    const params = new URLSearchParams(sp?.toString() ?? "");
    params.set("minProfit", String(overrides.minProfit ?? minProfit));
    params.set("minRoi", String(overrides.minRoi ?? minRoi));
    params.set("maxBsr", String(overrides.maxBsr ?? maxBsr));
    params.set("minSales", String(overrides.minSales ?? minSales));
    params.set("productType", overrides.productType ?? productType);
    params.set("buyingOption", overrides.buyingOption ?? buyingOption);
    params.set("ebayCondition", overrides.ebayCondition ?? ebayCondition);
    params.set("sortBy", overrides.sortBy ?? sortBy);
    startTransition(() => {
      router.push(`/?${params.toString()}`);
      router.refresh();
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    applyFilters();
  }

  return (
    <form
      onSubmit={onSubmit}
      className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-10"
    >
      <Field
        label="Mindest-Profit (€)"
        value={minProfit}
        onChange={setMinProfit}
        step="0.5"
        min={0}
      />
      <Field
        label="Mindest-ROI (%)"
        value={minRoi}
        onChange={setMinRoi}
        step="1"
        min={0}
      />
      <Field
        label="Max. BSR"
        value={maxBsr}
        onChange={setMaxBsr}
        step="10000"
        min={0}
      />
      <Field
        label="Min. Verkäufe/Monat"
        value={minSales}
        onChange={setMinSales}
        step="1"
        min={0}
      />
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-600">Kategorie</span>
        <select
          value={productType}
          onChange={(e) => {
            const next = e.target.value as Filters["productType"];
            setProductType(next);
            applyFilters({ productType: next });
          }}
          className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        >
          <option value="all">Alle</option>
          <option value="BOARD_GAME">Brettspiele</option>
          <option value="CD">CDs</option>
          <option value="DVD">DVD/Blu-ray</option>
          <option value="GAME">Games</option>
        </select>
      </label>
      <div className="flex flex-col gap-1 lg:col-span-2">
        <span className="text-xs font-medium text-slate-600">Ansicht</span>
        <div className="grid h-10 grid-cols-3 rounded-md border border-slate-300 bg-slate-50 p-0.5 text-xs font-medium">
          {[
            ["all", "Alle"],
            ["fixed", "Festpreis"],
            ["auction", "Auktionen"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                const next = value as Filters["buyingOption"];
                setBuyingOption(next);
                applyFilters({ buyingOption: next });
              }}
              className={
                buyingOption === value
                  ? "rounded bg-white text-slate-900 shadow-sm"
                  : "rounded text-slate-500 hover:text-slate-900"
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1 lg:col-span-2">
        <span className="text-xs font-medium text-slate-600">eBay-Zustand</span>
        <div className="grid h-10 grid-cols-3 rounded-md border border-slate-300 bg-slate-50 p-0.5 text-xs font-medium">
          {[
            ["all", "Alle"],
            ["new", "Neu"],
            ["used", "Gebraucht"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                const next = value as Filters["ebayCondition"];
                setEbayCondition(next);
                applyFilters({ ebayCondition: next });
              }}
              className={
                ebayCondition === value
                  ? "rounded bg-white text-slate-900 shadow-sm"
                  : "rounded text-slate-500 hover:text-slate-900"
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-600">Sortierung</span>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as Filters["sortBy"])}
          className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        >
          <option value="best_roi">Bester ROI</option>
          <option value="best_profit">Bester Profit</option>
          <option value="bsr">BSR</option>
          <option value="checked">Geprüft</option>
        </select>
      </label>
      <div className="flex items-end">
        <button
          type="submit"
          disabled={isPending}
          className="h-10 w-full rounded-md bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
        >
          {isPending ? "Filtere…" : "Filtern"}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  step,
  min,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step: string;
  min: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        step={step}
        min={min}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
      />
    </label>
  );
}
