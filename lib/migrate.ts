import { readFile } from "node:fs/promises";
import path from "node:path";
import { getPool } from "./db";

let applied = false;

export async function ensureDatabase(): Promise<void> {
  if (applied) return;

  const schemaPath = path.join(process.cwd(), "database", "schema.sql");
  const schemaSql = await readFile(schemaPath, "utf8");
  await getPool().query(schemaSql);
  applied = true;
}
