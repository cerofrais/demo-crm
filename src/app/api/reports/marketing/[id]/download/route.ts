/**
 * GET /api/reports/marketing/:id/download — streams a generated CSV back as an
 * attachment. Proxied through the app rather than handing out a presigned
 * storage URL, so the permission check applies to every fetch of the file.
 */
import { requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getObjectBuffer } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  let ctx;
  try {
    ctx = await requireSession();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!can(ctx.roles, "reports.allStaff")) {
    return new Response("Forbidden", { status: 403 });
  }

  const report = await prisma.marketingReport.findUnique({ where: { id: params.id } });
  if (!report) return new Response("Not found", { status: 404 });

  let buffer: Buffer;
  try {
    buffer = await getObjectBuffer(report.storageKey);
  } catch {
    // The row exists but the object is gone — say so plainly rather than
    // serving a zero-byte CSV that looks like "no leads that day".
    throw new ApiError("NOT_FOUND", "The stored file for this report is missing", 404);
  }

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${report.filename}"`,
      "Content-Length": String(buffer.byteLength),
      "Cache-Control": "private, no-store",
    },
  });
}
