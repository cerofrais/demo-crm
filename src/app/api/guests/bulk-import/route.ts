/**
 * POST /api/guests/bulk-import — bulk CSV guest upload (multipart file field
 * "file"). Creates/updates Guest rows only, no lead tickets. Admin/Manager
 * only — this mutates guest records directly, not scoped to any one lead.
 */
import { NextRequest } from "next/server";
import { handle, ok, requirePermission, ApiError } from "@/lib/api";
import { parseCsv } from "@/lib/csv";
import { bulkImportGuests } from "@/lib/enquiries";

export const dynamic = "force-dynamic";

const MAX_ROWS = 2000;

export async function POST(req: NextRequest) {
  return handle(async () => {
    await requirePermission("leads.manage");

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError("VALIDATION_ERROR", "No CSV file provided", 400);
    }

    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length === 0) {
      throw new ApiError("VALIDATION_ERROR", "The CSV has no data rows", 400);
    }
    if (rows.length > MAX_ROWS) {
      throw new ApiError("VALIDATION_ERROR", `Too many rows (${rows.length}) — max ${MAX_ROWS} per upload`, 400);
    }

    const tagField = form.get("tag");
    const tag = typeof tagField === "string" ? tagField : undefined;

    const result = await bulkImportGuests(rows, tag);
    return ok(result);
  });
}
