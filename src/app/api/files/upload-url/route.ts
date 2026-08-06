import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { canUploadDocCategory, type DocCategory } from "@/lib/rbac";
import {
  buildStorageKey,
  presignUpload,
  isAllowedUploadType,
  maxUploadBytes,
  putUploadBinding,
} from "@/lib/storage";
import { uploadUrlSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

// POST /api/files/upload-url — get a presigned PUT URL for a direct browser upload
export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    const input = uploadUrlSchema.parse(await req.json());

    if (!canUploadDocCategory(ctx.roles, input.category as DocCategory)) {
      throw new ApiError("FORBIDDEN", `Cannot upload ${input.category} documents`, 403);
    }

    // F46/F24: only sign uploads for an allowed MIME type (blocks SVG/HTML/text).
    if (!isAllowedUploadType(input.category, input.mimeType)) {
      throw new ApiError(
        "UNSUPPORTED_MEDIA_TYPE",
        `File type ${input.mimeType} is not allowed for ${input.category} documents`,
        415,
      );
    }

    // F39: reject an over-cap declared size before signing.
    const maxSize = maxUploadBytes(input.category);
    if (input.sizeBytes != null && input.sizeBytes > maxSize) {
      throw new ApiError(
        "PAYLOAD_TOO_LARGE",
        `File exceeds the ${Math.round(maxSize / 1024 / 1024)}MB limit`,
        413,
      );
    }

    // F8: the storage key is SERVER-MINTED — never accepted from the client.
    const storageKey = buildStorageKey({
      category: input.category,
      filename: input.filename,
      guestId: input.guestId,
      enquiryId: input.enquiryId,
    });
    const url = await presignUpload(storageKey, input.mimeType, {
      contentLength: input.sizeBytes,
    });

    // F8: remember exactly what we minted so /confirm can detect tampering.
    await putUploadBinding({
      sub: ctx.sub,
      key: storageKey,
      category: input.category,
      mime: input.mimeType,
      maxSize,
      guestId: input.guestId ?? null,
      enquiryId: input.enquiryId ?? null,
    });

    return ok({ url, storageKey, expiresInSeconds: 600 });
  });
}
