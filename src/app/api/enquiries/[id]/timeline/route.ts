import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can, canWorkLeadStage } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { stageLabel } from "@/lib/kanban";
import type { TimelineItemDTO } from "@/lib/types";
import type { EnquiryStage } from "@prisma/client";

export const dynamic = "force-dynamic";

// GET /api/enquiries/:id/timeline — merged activity + notes feed
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();

    // Same rule as remarks/tasks/edit — anyone who can see this lead can see
    // its timeline, still bounded by the same stage-visibility rule as
    // everything else (e.g. Doctor only for leads in Doctor Consultation).
    const enquiry = await prisma.enquiry.findUnique({
      where: { id: params.id },
      select: { assignedToSub: true, stage: true },
    });
    if (!enquiry) throw new ApiError("NOT_FOUND", "Enquiry not found", 404);
    const allowed = can(ctx.roles, "leads.view") && canWorkLeadStage(ctx.roles, enquiry.stage);
    if (!allowed) throw new ApiError("FORBIDDEN", "Cannot view this lead's timeline", 403);

    const [activities, notes] = await Promise.all([
      prisma.activity.findMany({
        where: { enquiryId: params.id },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      prisma.note.findMany({
        where: { enquiryId: params.id },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: { attachmentDocument: { select: { id: true, filename: true, mimeType: true, sizeBytes: true } } },
      }),
    ]);

    const items: TimelineItemDTO[] = [
      ...activities.map((a): TimelineItemDTO => ({
        id: a.id,
        kind: "activity",
        actorName: a.actorName ?? "System",
        text: describeActivity(a.actionType, a.metadata as Record<string, unknown>),
        createdAt: a.createdAt.toISOString(),
        meta: a.metadata as Record<string, unknown>,
      })),
      ...notes.map((n): TimelineItemDTO => ({
        id: n.id,
        kind: "note",
        actorName: n.authorName ?? "Staff",
        actorRole: n.authorRole,
        text: n.body,
        attachment: n.attachmentDocument,
        createdAt: n.createdAt.toISOString(),
      })),
    ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    return ok(items);
  });
}

function describeActivity(
  type: string,
  meta: Record<string, unknown>,
): string {
  switch (type) {
    case "created":
      return `Lead created${meta.source ? ` from ${meta.source}` : ""}`;
    case "assign":
      return meta.from && meta.from !== "Unassigned"
        ? `Reassigned from ${meta.from} to ${meta.to ?? "a staff member"}`
        : `Assigned to ${meta.to ?? "a staff member"}`;
    case "stage_change":
      return `Moved ${stageLabel(meta.from as EnquiryStage)} → ${stageLabel(
        meta.to as EnquiryStage,
      )}`;
    case "note":
      return "Added a remark";
    case "task_created":
      return `Added task: ${meta.title ?? "a reminder"}`;
    case "message_sent": {
      const channel = typeof meta.channel === "string" ? meta.channel : "a message";
      const via = typeof meta.numberLabel === "string" ? ` via ${meta.numberLabel}` : "";
      return `Sent ${channel}${via}`;
    }
    case "doc_upload":
      return "Uploaded a document";
    case "whatsapp_call_opened":
      return "Opened WhatsApp to call the guest";
    case "call_missed":
      return "Missed call — no one was available to pick up";
    case "call_hunt_next": {
      const from = typeof meta.from === "string" ? meta.from : "the first rep";
      const to = typeof meta.to === "string" ? meta.to : "the next rep";
      return `${from} didn't pick up — call routed to ${to}`;
    }
    case "consent":
      return "Consent recorded";
    case "deletion_decision":
      return meta.approved
        ? `Approved deletion${meta.reason ? ` — ${meta.reason}` : ""}`
        : `Denied deletion${meta.reason ? ` — ${meta.reason}` : ""}`;
    case "auto_deleted":
      return "Auto-deleted — Lost/Dead deletion window elapsed";
    case "doctor_decision": {
      const label = meta.decision === "accepted" ? "Accepted"
        : meta.decision === "rejected" ? "Rejected"
        : "Needs phone consult";
      return `Doctor consultation: ${label}${meta.note ? ` — ${meta.note}` : ""}`;
    }
    case "lead_revived":
      return "Re-engaged — moved back to Contacted";
    case "message_edited":
      return "Corrected a message";
    case "message_deleted":
      return "Deleted a message";
    case "contact_update": {
      const changes = Array.isArray(meta.changes) ? (meta.changes as string[]) : [];
      return changes.length ? `Updated details: ${changes.join("; ")}` : "Updated lead details";
    }
    case "duplicate_merged": {
      const via = typeof meta.source === "string" ? ` via ${meta.source}` : "";
      const campaign = typeof meta.campaignLabel === "string" ? ` (campaign: ${meta.campaignLabel})` : "";
      return `Merged a duplicate submission${via}${campaign}`;
    }
    default:
      return type;
  }
}
