/**
 * GET /api/admin/ask-db/history/[id] — the answer a question was given.
 *
 * Read straight back out of the AI audit row, so re-opening yesterday's
 * question costs nothing: no model call, no query, and the answer shown is
 * the one someone actually acted on rather than a fresh one against data that
 * has since moved. The page offers "Run again" for when today's number is
 * what is wanted.
 */
import { NextRequest } from "next/server";
import { ApiError, handle, ok, requirePermission } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { savedAnswerFrom } from "@/lib/ask-db-saved";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    await requirePermission("db.query");

    const row = await prisma.aiDecision.findFirst({
      where: { id: params.id, kind: "db_question" },
      select: { id: true, createdAt: true, success: true, output: true, triggeredByName: true },
    });
    if (!row) throw new ApiError("NOT_FOUND", "That question is no longer in the log.", 404);

    const output = (row.output ?? {}) as { question?: unknown; sql?: unknown };
    const saved = savedAnswerFrom(row.output);
    if (!saved) {
      throw new ApiError(
        "NOT_FOUND",
        "That question was asked before answers were kept — ask it again to see the answer.",
        404,
      );
    }

    return ok({
      id: row.id,
      question: typeof output.question === "string" ? output.question : "",
      sql: typeof output.sql === "string" ? output.sql : null,
      askedAt: row.createdAt.toISOString(),
      askedBy: row.triggeredByName,
      answer: saved,
    });
  });
}
