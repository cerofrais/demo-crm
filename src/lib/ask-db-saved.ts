/**
 * Keeping the answer, not just the question.
 *
 * The console already wrote every question to the AI audit log; what it threw
 * away was what came back. So re-opening yesterday's question meant asking
 * gemma again — twenty seconds of GPU, a fresh query against a database that
 * has moved on, and an answer that might not match the one someone acted on.
 * The answer is now stored beside the question, and the page shows it back
 * with the time it was given, with re-running left as a deliberate click.
 *
 * What is kept is a SUMMARY, not the full result: a thousand-row export does
 * not belong in an audit row, and an answer worth re-reading is one someone
 * could take in on a screen. The caps below are what that costs.
 */

/** Rows kept from a table answer. Past this, re-run it. */
export const SAVED_ROWS = 20;
/** Longest cell text kept — enough to read, short enough not to bloat a row. */
const SAVED_CELL = 300;
/** Evidence entries kept from a lead answer. */
const SAVED_EVIDENCE = 8;

export interface SavedSqlAnswer {
  mode: "sql";
  explanation: string | null;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** True when the saved rows are fewer than the answer had. */
  rowsTrimmed: boolean;
}

export interface SavedLeadAnswer {
  mode: "lead";
  answer: string;
  lead: { enquiryId: string; name: string; stage: string } | null;
  evidence: { n: number; at: string; kind: string; who: string; detail: string }[];
}

export type SavedAnswer = SavedSqlAnswer | SavedLeadAnswer;

function cell(value: unknown): unknown {
  if (typeof value === "string") return value.length > SAVED_CELL ? `${value.slice(0, SAVED_CELL)}…` : value;
  if (value === null || typeof value !== "object") return value;
  const json = JSON.stringify(value);
  return json.length > SAVED_CELL ? `${json.slice(0, SAVED_CELL)}…` : value;
}

export function summariseSqlAnswer(input: {
  explanation: string | null;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}): SavedSqlAnswer {
  const rows = input.rows.slice(0, SAVED_ROWS).map((row) => {
    const out: Record<string, unknown> = {};
    for (const key of input.columns) out[key] = cell(row[key]);
    return out;
  });
  return {
    mode: "sql",
    explanation: input.explanation,
    columns: input.columns,
    rows,
    rowCount: input.rowCount,
    rowsTrimmed: input.rowCount > rows.length,
  };
}

export function summariseLeadAnswer(input: {
  answer: string;
  lead: { enquiryId: string; name: string; stage: string } | null;
  evidence: { n: number; at: string; kind: string; who: string; detail: string }[];
}): SavedLeadAnswer {
  return {
    mode: "lead",
    answer: input.answer,
    lead: input.lead,
    evidence: input.evidence.slice(0, SAVED_EVIDENCE).map((e) => ({
      ...e,
      detail: e.detail.length > SAVED_CELL ? `${e.detail.slice(0, SAVED_CELL)}…` : e.detail,
    })),
  };
}

/**
 * Read a saved answer back out of an audit row's `output`.
 *
 * Rows written before answers were kept simply have none — they still list,
 * they just cannot be re-opened, which is better than pretending.
 */
export function savedAnswerFrom(output: unknown): SavedAnswer | null {
  const saved = (output as { saved?: unknown } | null)?.saved as Partial<SavedAnswer> | undefined;
  if (!saved || typeof saved !== "object") return null;

  if (saved.mode === "lead" && typeof (saved as SavedLeadAnswer).answer === "string") {
    const lead = saved as SavedLeadAnswer;
    return { mode: "lead", answer: lead.answer, lead: lead.lead ?? null, evidence: lead.evidence ?? [] };
  }
  if (saved.mode === "sql" && Array.isArray((saved as SavedSqlAnswer).columns)) {
    const sql = saved as SavedSqlAnswer;
    return {
      mode: "sql",
      explanation: sql.explanation ?? null,
      columns: sql.columns,
      rows: Array.isArray(sql.rows) ? sql.rows : [],
      rowCount: typeof sql.rowCount === "number" ? sql.rowCount : 0,
      rowsTrimmed: Boolean(sql.rowsTrimmed),
    };
  }
  return null;
}
