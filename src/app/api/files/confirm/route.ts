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

    // ONE FILE PER NAME, per place — the shared Resources library, or one
    // guest's own documents. Re-uploading a name that is already here is
    // either a deliberate replacement or an accident; without this check it
    // was always an accident, and the library ended up holding 34 identical
    // copies of one broadcast image (every send re-uploaded it).
    //
    // Scope is guest/enquiry, NOT category: two files can't share a name in
    // one place just because they were filed differently, or the picker shows
    // the staff member the same name twice with no way to tell them apart.
    const clash = await prisma.document.findFirst({
      where: {
        filename: input.filename,
        guestId: binding.guestId ?? null,
        enquiryId: binding.enquiryId ?? null,
      },
      orderBy: { createdAt: "asc" },
    });

    if (clash && input.replaceDocumentId !== clash.id) {
      // The object stays put and the binding is NOT consumed, so the client
      // can confirm again with replaceDocumentId the moment the staff member
      // picks "Replace" — no second upload of the same bytes.
      throw new ApiError(
        "DUPLICATE_FILENAME",
        `A file named "${input.filename}" is already here. Replace it, or upload it under a different name.`,
        409,
      );
    }

    // REPLACE reuses the existing row rather than creating a new one, so
    // every message, auto-reply, welcome email and broadcast already pointing
    // at this document keeps resolving — to the new file. Creating a new row
    // and deleting the old one would break all of them.
    if (clash) {
      const supersededKey = clash.storageKey;
      const replaced = await prisma.document.update({
        where: { id: clash.id },
        data: {
          category: binding.category as DocumentCategory,
          mimeType: binding.mime,
          storageKey: input.storageKey,
          sizeBytes: head.contentLength || input.sizeBytes,
          uploadedBy: ctx.sub,
        },
      });
      if (supersededKey !== input.storageKey) {
        await deleteObject(supersededKey).catch(() => {});
      }
      await clearUploadBinding(input.storageKey);

      await prisma.activity.create({
        data: {
          guestId: input.guestId,
          enquiryId: input.enquiryId,
          actorSub: ctx.sub,
          actorRole: ctx.roles[0] ?? "STAFF",
          actorName: ctx.name,
          actionType: "doc_replace",
          metadata: {
            documentId: replaced.id,
            category: input.category,
            filename: input.filename,
          },
        },
      });

      return ok({ id: replaced.id, replaced: true });
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
