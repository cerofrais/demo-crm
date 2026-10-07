/**
 * POST /api/admin/ask-db — ask the database a question in plain English.
 *
 * Body: { question } to have the model answer it — as SQL over the readable
 * tables, or as a narrative about one named lead, whichever the question is;
 * { question, sql } to run SQL an admin edited on the page, which still goes
 * through the same guard (ask-db-guard) and the same read-only execution
 * (ask-db-run); { question, enquiryId } to answer about the lead the admin
 * picked when a name matched several.
 *
 * A failed query answers 200 with ok:false rather than an error status: the
 * SQL that failed is what the admin needs to see, and the standard error
 * envelope carries only a message.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, handle, ok, requirePermission } from "@/lib/api";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { aiFeatureEnabled } from "@/lib/ai/config";
import { askDatabase, AiNotEnabled } from "@/lib/ai/ask-db";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A question is one or two gemma generations on the shared GPU plus the query.
export const maxDuration = 300;

const ASK_PER_MIN = Number(process.env.ASK_DB_PER_MIN ?? 10);

const Body = z.object({
  question: z.string().trim().min(3, "Ask a question first.").max(1000, "That question is too long."),
  /** Present when the admin edited the SQL and re-ran it. */
  sql: z.string().trim().max(8000).optional(),
  /** Present when the admin picked one lead out of several matches. */
  enquiryId: z.string().uuid().optional(),
});

const asNext = (r: Response) => new NextResponse(r.body, { status: r.status, headers: r.headers });

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requirePermission("db.query");
    const body = Body.parse(await req.json());

    if (!body.sql && !aiFeatureEnabled("askDb")) {
      throw new ApiError("AI_DISABLED", "Ask-the-database is not enabled on this server (AI_FEATURE_ASK_DB).", 503);
    }

    const limit = await rateLimit({ key: `ask-db:${ctx.sub}`, limit: ASK_PER_MIN, windowSec: 60 });
    if (!limit.allowed) return asNext(rateLimitResponse(limit));

    try {
      const answer = await askDatabase({
        question: body.question,
        sql: body.sql,
        enquiryId: body.enquiryId,
        triggeredBy: ctx.sub,
        triggeredByName: ctx.name,
      });
      logger.info(
        {
          by: ctx.sub,
          ok: answer.ok,
          mode: answer.mode,
          rows: answer.ok && answer.mode === "sql" ? answer.result.rowCount : 0,
          handWritten: Boolean(body.sql),
        },
        "ask-db question answered",
      );
      return ok(answer);
    } catch (err) {
      if (err instanceof AiNotEnabled) throw new ApiError("AI_DISABLED", err.message, 503);
      throw err;
    }
  });
}
