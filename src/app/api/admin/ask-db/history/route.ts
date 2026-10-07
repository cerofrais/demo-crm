/**
 * GET /api/admin/ask-db/history — the questions this console has been asked.
 *
 * Read straight out of the AI audit log, which already holds one row per
 * question; see lib/ask-db-history.ts for why there is no second table. The
 * whole page is admin-only, so the list is everyone's questions rather than
 * just the reader's — on a two-admin CRM "what did we already ask about this"
 * is the useful version — with each entry marked as theirs or someone else's.
 */
import { NextRequest } from "next/server";
import { handle, ok, requirePermission } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { recentQuestions } from "@/lib/ask-db-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Scanned before de-duplication, so repeats of one question don't crowd it out. */
const SCAN = 120;

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requirePermission("db.query");
    const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 12) || 12, 30);

    const rows = await prisma.aiDecision.findMany({
      where: { kind: "db_question" },
      orderBy: { createdAt: "desc" },
      take: SCAN,
      select: { id: true, createdAt: true, success: true, output: true, triggeredBy: true, triggeredByName: true },
    });

    return ok(recentQuestions(rows, ctx.sub, limit));
  });
}
