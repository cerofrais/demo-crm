import { NextRequest } from "next/server";
import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { canMutateLeads, canWorkLeadStage } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { addNoteSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

// POST /api/enquiries/:id/notes — append a remark (required for lead updates)
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    const { body, attachmentDocumentId } = addNoteSchema.parse(await req.json());

    const enquiry = await prisma.enquiry.findUnique({ where: { id: params.id } });
    if (!enquiry) throw new ApiError("NOT_FOUND", "Enquiry not found", 404);

    // Anyone who actually works leads can leave a remark on it — not just
    // its owner or a manager (Doctor, and any non-owning rep with
    // leads.ownOnly, included) — but a bare read-only leads.view holder
    // (Viewer/Staff) cannot. Still bounded by the same stage-visibility rule
    // as everything else (e.g. Sales loses this once a lead passes Booking
    // Confirmed, Doctor only for leads currently in Doctor Consultation).
    const allowed = canMutateLeads(ctx.roles) && canWorkLeadStage(ctx.roles, enquiry.stage);
    if (!allowed) throw new ApiError("FORBIDDEN", "Cannot add notes to this lead", 403);

    // Same "already uploaded, scoped to this guest" check the WhatsApp/email
    // send routes use for their own attachmentDocumentId — a caller can't
    // attach someone else's document just by guessing its id.
    if (attachmentDocumentId) {
      const doc = await prisma.document.findFirst({
        where: { id: attachmentDocumentId, guestId: enquiry.guestId },
        select: { id: true },
      });
      if (!doc) throw new ApiError("NOT_FOUND", "Attachment not found", 404);
    }

    const note = await prisma.note.create({
      data: {
        enquiryId: params.id,
        authorSub: ctx.sub,
        authorName: ctx.name,
        authorRole: ctx.roles[0] ?? "STAFF",
        body,
        attachmentDocumentId,
      },
      include: { attachmentDocument: { select: { id: true, filename: true, mimeType: true, sizeBytes: true } } },
    });
    await prisma.$transaction([
      prisma.activity.create({
        data: {
          enquiryId: params.id,
          guestId: enquiry.guestId,
          actorSub: ctx.sub,
          actorRole: ctx.roles[0] ?? "STAFF",
          actorName: ctx.name,
          actionType: "note",
          metadata: { noteId: note.id },
        },
      }),
      prisma.enquiry.update({
        where: { id: params.id },
        data: { lastActivityAt: new Date() },
      }),
    ]);

    return ok(
      {
        id: note.id,
        authorName: note.authorName,
        body: note.body,
        attachment: note.attachmentDocument,
        createdAt: note.createdAt.toISOString(),
      },
      undefined,
      201,
    );
  });
}
