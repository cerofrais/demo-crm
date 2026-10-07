/**
 * Running a guarded query against Postgres, with the limits that make an
 * unattended model-written SELECT safe to execute on the production box.
 *
 *  • READ ONLY transaction — Postgres refuses every write inside it, whatever
 *    the SQL turns out to be. This is the layer that does not depend on the
 *    guard's keyword list being complete.
 *  • statement_timeout — a careless cross join can't pin the CPU the CRM and
 *    the message pipeline are sharing.
 *  • a LIMIT wrapped around the whole query rather than appended to it, so it
 *    holds for a UNION or a query that already ends in its own LIMIT, and a
 *    "show me every message" answer can't try to stream 400k rows into a
 *    browser tab.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export const MAX_ROWS = 500;
const STATEMENT_TIMEOUT_MS = 20_000;
/** Room for the statement plus connection acquisition. */
const TRANSACTION_TIMEOUT_MS = 30_000;

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** True when the answer was cut off at MAX_ROWS. */
  truncated: boolean;
  durationMs: number;
}

/** A Postgres error, phrased for the admin reading it (and for the retry). */
export class QueryFailed extends Error {
  constructor(message: string) {
    super(message);
  }
}

export async function runReadOnlyQuery(sql: string): Promise<QueryResult> {
  const wrapped = `SELECT * FROM (\n${sql}\n) AS "q" LIMIT ${MAX_ROWS + 1}`;
  const started = Date.now();

  let raw: unknown;
  try {
    raw = await prisma.$transaction(
      async (tx) => {
        // Must come before anything else in the transaction.
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        return tx.$queryRawUnsafe(wrapped);
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: 5_000 },
    );
  } catch (err) {
    throw new QueryFailed(postgresMessage(err));
  }

  const all = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
  const truncated = all.length > MAX_ROWS;
  const rows = (truncated ? all.slice(0, MAX_ROWS) : all).map(serializeRow);
  const columns = rows.length ? Object.keys(rows[0]) : [];

  return { columns, rows, rowCount: rows.length, truncated, durationMs: Date.now() - started };
}

/** The part of a Prisma raw error worth showing — its own wrapper is noise. */
function postgresMessage(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { message?: string; code?: string } | undefined;
    if (meta?.message) return meta.message;
  }
  const text = err instanceof Error ? err.message : String(err);
  // Prisma prints the raw driver error after a banner of newlines.
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  const message = last && last.length > 10 ? last : text;
  return message.replace(/^Raw query failed\.\s*/i, "").slice(0, 500);
}

/**
 * JSON-safe values. Postgres hands back bigint for count(*), Decimal for
 * numeric and Buffer for bytea, none of which survive JSON.stringify.
 */
function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = serializeValue(value);
  return out;
}

function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<${value.length} bytes>`;
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === "object") {
    const obj = value as { toFixed?: unknown; toString(): string };
    // Prisma.Decimal and friends: numeric-like objects with a toFixed.
    if (typeof obj.toFixed === "function") return Number(obj.toString());
    return JSON.parse(JSON.stringify(value));
  }
  return value;
}
