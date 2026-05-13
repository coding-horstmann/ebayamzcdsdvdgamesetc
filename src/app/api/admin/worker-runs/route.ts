import { NextResponse } from "next/server";
import { ensureDatabase } from "../../../../../lib/migrate";
import { listRecentWorkerRuns } from "../../../../worker/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureDatabase();
    const runs = await listRecentWorkerRuns(12);
    return NextResponse.json({ runs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unbekannter Fehler";
    return NextResponse.json({ runs: [], error: message }, { status: 500 });
  }
}
