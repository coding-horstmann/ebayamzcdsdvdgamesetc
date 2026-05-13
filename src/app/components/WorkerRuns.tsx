"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkerRunRow } from "../../../lib/db";

type ApiResponse = {
  runs: WorkerRunRow[];
  error?: string;
};

function fmtDate(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "-";
  return d.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined) return "-";
  return v.toLocaleString("de-DE");
}

function statusText(run: WorkerRunRow): string {
  if (run.status === "done") return "ok";
  if (run.status === "done_with_warnings") return "Hinweis";
  if (
    run.status === "aborted" &&
    (run.ebay_rate_limits > 0 ||
      run.error_messages?.some((msg) => msg.includes("eBay-Kontingent")) === true)
  ) {
    return "eBay-Limit";
  }
  if (run.status === "aborted") return "abgebrochen";
  if (run.status === "error") return "Fehler";
  return "läuft";
}

function statusClass(run: WorkerRunRow): string {
  if (run.status === "done") return "bg-green-100 text-green-700";
  if (run.status === "done_with_warnings") return "bg-amber-100 text-amber-700";
  if (
    run.status === "aborted" &&
    (run.ebay_rate_limits > 0 ||
      run.error_messages?.some((msg) => msg.includes("eBay-Kontingent")) === true)
  ) {
    return "bg-amber-100 text-amber-700";
  }
  if (run.status === "running") return "bg-blue-100 text-blue-700";
  return "bg-red-100 text-red-700";
}

export default function WorkerRuns() {
  const [runs, setRuns] = useState<WorkerRunRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/worker-runs", { cache: "no-store" });
      const json = (await res.json()) as ApiResponse;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRuns(json.runs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unbekannter Fehler");
    }
  }, []);

  useEffect(() => {
    fetchRuns();
    const timer = setInterval(fetchRuns, 10000);
    return () => clearInterval(timer);
  }, [fetchRuns]);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Worker-Runs</h2>
          <p className="text-xs text-slate-500">
            Die letzten Läufe mit Scan-Fortschritt und eBay-Ergebnis.
          </p>
        </div>
        <button
          type="button"
          onClick={fetchRuns}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Aktualisieren
        </button>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Fehler: {error}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Start</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">BSR</th>
              <th className="px-3 py-2 text-right">Geprüft</th>
              <th className="px-3 py-2 text-right">Festpreis</th>
              <th className="px-3 py-2 text-right">Auktionen</th>
              <th className="px-3 py-2 text-right">Chancen</th>
              <th className="px-3 py-2 text-right">eBay-Suchen</th>
              <th className="px-3 py-2 text-right">Dauer</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {runs.map((run) => (
              <tr key={run.id}>
                <td className="whitespace-nowrap px-3 py-2">{fmtDate(run.started_at)}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClass(run)}`}>
                    {statusText(run)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {run.bsr_from && run.bsr_to ? `${fmtInt(run.bsr_from)}-${fmtInt(run.bsr_to)}` : "-"}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">{fmtInt(run.scanned)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">{fmtInt(run.fixed_hits)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">{fmtInt(run.auction_hits)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">{fmtInt(run.deals)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {fmtInt(run.ebay_searches)}
                  {run.ebay_rate_limits > 0 || run.ebay_errors > 0 ? (
                    <span className="ml-1 text-xs text-red-600">
                      ({run.ebay_rate_limits + run.ebay_errors})
                    </span>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {run.duration_minutes === null ? "-" : `${run.duration_minutes} min`}
                </td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-slate-500">
                  Noch keine gespeicherten Worker-Runs.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
