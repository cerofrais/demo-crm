/**
 * POST /api/internal/sheet-check/tick — called once a day by the
 * sheet-check-cron container. Runs the lead sheet check when it's due.
 *
 * No session: the caller is a container, not a person. Guarded by a shared
 * secret instead (SHEET_CHECK_CRON_SECRET, sent as X-Cron-Secret). The
 * middleware doesn't cover /api, so this check is the only gate — which is
 * why an unset secret refuses everything rather than allowing it.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { logger } from "@/lib/logger";
import { tickSheetCheck } from "@/lib/sheet-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function secretMatches(given: string | null): boolean {
  const expected = process.env.SHEET_CHECK_CRON_SECRET ?? "";
  if (!expected || !given) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!process.env.SHEET_CHECK_CRON_SECRET) {
    return NextResponse.json({ error: { code: "NOT_CONFIGURED", message: "SHEET_CHECK_CRON_SECRET is not set" } }, { status: 503 });
  }
  if (!secretMatches(req.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "Bad cron secret" } }, { status: 403 });
  }
  try {
    const out = await tickSheetCheck();
    const body = {
      ran: out.ran,
      reason: out.reason,
      ...(out.result && {
        status: out.result.status,
        checked: out.result.checked,
        missing: out.result.missing,
        pushed: out.result.pushed,
        pushFailed: out.result.pushFailed,
        sheetErrors: out.result.sheetErrors,
        emailedTo: out.result.emailedTo,
      }),
    };
    logger.info(body, "sheet check tick");
    return NextResponse.json({ data: body });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sheet check failed";
    logger.error({ err }, "sheet check tick failed");
    return NextResponse.json({ error: { code: "CHECK_FAILED", message } }, { status: 500 });
  }
}
