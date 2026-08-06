import { handle, ok, requireSession } from "@/lib/api";
import {
  readableDocCategories,
  canUploadDocCategory,
  type DocCategory,
} from "@/lib/rbac";

export const dynamic = "force-dynamic";

const ALL: DocCategory[] = ["medical", "consent", "operational", "marketing"];

// GET /api/files/meta — which document categories the current user can read/upload
export async function GET() {
  return handle(async () => {
    const ctx = await requireSession();
    return ok({
      readable: readableDocCategories(ctx.roles),
      uploadable: ALL.filter((c) => canUploadDocCategory(ctx.roles, c)),
    });
  });
}
