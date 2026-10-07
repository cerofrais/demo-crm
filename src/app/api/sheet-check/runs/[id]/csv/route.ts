/** GET /api/sheet-check/runs/:id/csv — the missing-leads CSV from one run. */
import { requireSession } from "@/lib/api";
import { canAny } from "@/lib/rbac";
import { getRunCsv } from "@/lib/sheet-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  let ctx;
  try {
    ctx = await requireSession();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!canAny(ctx.roles, ["leads.manage", "lead-assignment.view"])) return new Response("Forbidden", { status: 403 });
  const csv = await getRunCsv(params.id).catch(() => null);
  if (!csv) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(csv.buffer), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csv.filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
