/**
 * The questions this page has already been asked.
 *
 * Nothing new is stored for this: every question already lands in the AI audit
 * log (ai/ask-db.ts writes one AiDecision per question, with the SQL or the
 * lead it read), so the history is a read of rows that exist. A separate
 * "saved questions" table would be a second copy of the same facts, and the
 * two would drift the first time one of them was written and the other wasn't.
 *
 * What the page wants is not the raw log, though: the same question asked
 * three times while someone narrowed it down is one entry, and the newest
 * telling is the one worth keeping — it carries whether it worked in the end.
 */

import { savedAnswerFrom } from "./ask-db-saved";

export interface AskedQuestion {
  id: string;
  question: string;
  /** IST, already formatted — the client does no date maths. */
  at: string;
  ok: boolean;
  mode: "sql" | "lead" | null;
  /** Who asked, so a shared console reads as a shared console. */
  by: string | null;
  /** True when this session's user asked it. */
  mine: boolean;
  /** The answer was kept and can be re-opened without asking again. Older
   *  rows, written before answers were saved, have none. */
  hasAnswer: boolean;
}

interface DecisionRow {
  id: string;
  createdAt: Date;
  success: boolean;
  output: unknown;
  triggeredBy: string | null;
  triggeredByName: string | null;
}

const istFormat = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

/**
 * Newest first, one entry per distinct question.
 *
 * Rows must arrive newest first; the first time a question is seen is
 * therefore the last time it was asked, which is the row kept.
 */
export function recentQuestions(rows: DecisionRow[], viewerSub: string, limit = 12): AskedQuestion[] {
  const seen = new Set<string>();
  const out: AskedQuestion[] = [];

  for (const row of rows) {
    const output = (row.output ?? {}) as { question?: unknown; mode?: unknown; sql?: unknown };
    const question = typeof output.question === "string" ? output.question.trim() : "";
    if (!question) continue; // a row written before the question was recorded

    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const mode = output.mode === "lead" ? "lead" : output.mode === "sql" || output.sql ? "sql" : null;
    out.push({
      id: row.id,
      question,
      at: istFormat(row.createdAt),
      ok: row.success,
      mode,
      by: row.triggeredByName,
      mine: row.triggeredBy === viewerSub,
      hasAnswer: savedAnswerFrom(row.output) !== null,
    });
    if (out.length >= limit) break;
  }

  return out;
}
