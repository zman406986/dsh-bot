import type { DatabaseSync } from "node:sqlite";
import { LedgerError } from "./types.js";

export type SqlValue = string | number | bigint | Uint8Array | null;
export type Row = Record<string, unknown>;

/** `node:sqlite` returns `unknown`; narrow it once here instead of casting at each call. */
export function asRow(value: unknown, where: string): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LedgerError("storage", `Invalid ${where} row`);
  }
  return value as Row;
}

export function asRows(value: unknown, where: string): Row[] {
  if (!Array.isArray(value)) throw new LedgerError("storage", `Invalid ${where} rows`);
  return value.map((item: unknown) => asRow(item, where));
}

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new LedgerError("storage", `Invalid ${column}`);
  return value;
}

export function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new LedgerError("storage", `Invalid ${column}`);
  }
  return value;
}

/** Table and column identifiers are private constants, never caller input. */
export function insertImmutable(
  db: DatabaseSync, table: string, key: Readonly<Record<string, SqlValue>>,
  values: Readonly<Record<string, SqlValue>>, createdAtMs?: number,
): void {
  const where = Object.keys(key).map(column => `${column} = ?`).join(" AND ");
  const found = db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...Object.values(key));
  if (found !== undefined) {
    const existing = asRow(found, table);
    for (const [column, value] of Object.entries(values)) {
      if (existing[column] !== value) {
        throw new LedgerError("idempotency-conflict", `Conflicting ${table}.${column}`);
      }
    }
    return;
  }
  const insert = createdAtMs === undefined ? values : { ...values, created_at_ms: createdAtMs };
  const columns = Object.keys(insert);
  try {
    db.prepare(`INSERT INTO ${table} (${columns.join(", ")})
      VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(insert));
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/i.test(error.message)) {
      throw new LedgerError("idempotency-conflict", `Conflicting key in ${table}`, { cause: error });
    }
    throw error;
  }
}
