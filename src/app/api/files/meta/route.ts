import { handle, ok, requireSession } from "@/lib/api";
import { DOC_CATEGORIES, readableDocCategories, canUploadDocCategory } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// GET /api/files/meta — which document categories the current user can read/upload
export async function GET() {
  return handle(async () => {
    const ctx = await requireSession();
    return ok({
      readable: readableDocCategories(ctx.roles),
      // DOC_CATEGORIES, not a local copy — this endpoint feeds the Resources
      // upload picker, and its own hardcoded list silently omitted `private`
      // while the filter beside it (readableDocCategories) offered it. The
      // category could be filtered for but never chosen at upload.
      uploadable: DOC_CATEGORIES.filter((c) => canUploadDocCategory(ctx.roles, c)),
    });
  });
}
