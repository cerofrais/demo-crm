import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { canUploadDocCategory, type DocCategory } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { confirmUploadSchema } from "@/lib/validation";
import {
  getUploadBinding,
  clearUploadBinding,
  headObject,
  deleteObject,
  isAllowedUploadType,
} from "@/lib/storage";
import type { DocumentCategory } from "@prisma/client";

export const dynamic = "force-dynamic";

// POST /api/files/confirm — after the browser PUT succeeds, create the Document row
export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    const input = confirmUploadSchema.parse(await req.json());

    if (!canUploadDocCategory(ctx.roles, input.category as DocCategory)) {
      throw new ApiError("FORBIDDEN", `Cannot upload ${input.category} documents`, 403);
    }

    // F8: the key must map to a binding WE minted for THIS user. A client can't
    // confirm an arbitrary key (e.g. re-attach a `medical/...` object as
    // `operational`) because it never minted a binding for it.
    const binding = await getUploadBinding(input.storageKey);
    if (!binding || binding.sub !== ctx.sub) {
      throw new ApiError("BAD_REQUEST", "Upload session not found or expired", 400);
    }

    // Reject any client field that diverges from what was signed.
    if (
      binding.category !== input.category ||
      binding.mime !== input.mimeType ||
      (binding.guestId ?? null) !== (input.guestId ?? null) ||
      (binding.enquiryId ?? null) !== (input.enquiryId ?? null)
    ) {
      throw new ApiError(
        "BAD_REQUEST",
        "Upload metadata does not match the signed request",
        400,
      );
    }

    // F46/F24: defence in depth against a disallowed type slipping through.
    if (!isAllowedUploadType(input.category, input.mimeType)) {
      throw new ApiError(
        "UNSUPPORTED_MEDIA_TYPE",
        `File type ${input.mimeType} is not allowed`,
        415,
      );
    }

    // F39: reject over-cap declared size, then reconcile against the REAL object.
    if (input.sizeBytes > binding.maxSize) {
      await deleteObject(input.storageKey).catch(() => {});
      throw new ApiError("PAYLOAD_TOO_LARGE", "File exceeds the allowed size", 413);
    }
    const head = await headObject(input.storageKey);
    if (head.contentLength > binding.maxSize) {
      await deleteObject(input.storageKey).catch(() => {});
      throw new ApiError(
        "PAYLOAD_TOO_LARGE",
        "Uploaded file exceeds the allowed size",
        413,
      );
    }
    // F8: the stored object's Content-Type is the one we signed; a mismatch
    // means the object isn't what we minted for.
    if (head.contentType && head.contentType !== binding.mime) {
      await deleteObject(input.storageKey).catch(() => {});
      throw new ApiError(
        "BAD_REQUEST",
        "Uploaded content type does not match the signed request",
        400,
      );
    }

    const doc = await prisma.document.create({
      data: {
        // Persist the trusted minted values / real size, not raw client input.
        category: binding.category as DocumentCategory,
        filename: input.filename,
        mimeType: binding.mime,
        storageKey: input.storageKey,
        sizeBytes: head.contentLength || input.sizeBytes,
        uploadedBy: ctx.sub,
        guestId: binding.guestId ?? undefined,
        enquiryId: binding.enquiryId ?? undefined,
      },
    });

    // One-time use: consume the binding so the key can't be re-confirmed.
    await clearUploadBinding(input.storageKey);

    await prisma.activity.create({
      data: {
        guestId: input.guestId,
        enquiryId: input.enquiryId,
        actorSub: ctx.sub,
        actorRole: ctx.roles[0] ?? "STAFF",
        actorName: ctx.name,
        actionType: "doc_upload",
        metadata: { documentId: doc.id, category: input.category, filename: input.filename },
      },
    });

    return ok({ id: doc.id }, undefined, 201);
  });
}
