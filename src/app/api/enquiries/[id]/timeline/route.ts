import { handle, ok, requireSession, ApiError } from "@/lib/api";
import { can, canViewLeadStage } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { mediaForActivities } from "@/lib/activity-media";
import { stageLabel } from "@/lib/kanban";
import type { TimelineItemDTO } from "@/lib/types";
import type { EnquiryStage } from "@prisma/client";
import { transcriptExcerpt, transcriptStatusText, transcriptText } from "@/lib/voice-note";
import { voiceNoteTranscriptionEnabled } from "@/lib/ai/config";

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
    const allowed = can(ctx.roles, "leads.view") && canViewLeadStage(ctx.roles, enquiry.stage);
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

    // Voice notes keep their transcript on the Message; one query for the
    // whole page rather than one per row.
    const [voiceNotes, media] = await Promise.all([
      voiceNoteTranscripts(activities.map((a) => a.metadata)),
      mediaForActivities(activities),
    ]);

    const items: TimelineItemDTO[] = [
      ...activities.map((a): TimelineItemDTO => {
        const meta = a.metadata as Record<string, unknown>;
        const voice =
          meta.voiceNote === true && typeof meta.messageId === "string"
            ? voiceNotes.get(meta.messageId)
            : undefined;
        return {
          id: a.id,
          kind: "activity",
          // The photo or voice note the message carried, so the log can show
          // it rather than describe it — see lib/activity-media.ts.
          attachment: media.get(a.id)?.attachment ?? null,
          actionType: a.actionType,
          actorName: a.actorName ?? "System",
          text: describeActivity(a.actionType, meta),
          createdAt: a.createdAt.toISOString(),
          // The transcript rides along on meta so the drawer needs no second
          // fetch — same place it already reads taskId from.
          meta: voice ? { ...meta, ...voice } : meta,
        };
      }),
      ...notes.map((n): TimelineItemDTO => ({
        id: n.id,
        kind: "note",
        actorName: n.authorName ?? "Staff",
        actorRole: n.authorRole,
        noteKind: n.kind,
        text: n.body,
        attachment: n.attachmentDocument,
        createdAt: n.createdAt.toISOString(),
      })),
    ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    return ok(items);
  });
}

/** English transcript (or why there isn't one) for each voice-note activity. */
async function voiceNoteTranscripts(
  metadatas: unknown[],
): Promise<Map<string, { transcript: string | null; transcriptStatus: string | null }>> {
  const ids = metadatas
    .map((m) => {
      const meta = m as { voiceNote?: unknown; messageId?: unknown } | null;
      return meta?.voiceNote === true && typeof meta.messageId === "string" ? meta.messageId : null;
    })
    .filter((id): id is string => !!id);
  if (!ids.length) return new Map();
  // A deleted message's transcript stays hidden, same as its body.
  const rows = await prisma.message.findMany({
    where: { id: { in: [...new Set(ids)] }, deletedAt: null },
    select: {
      id: true,
      transcript: true,
      transcriptEnglish: true,
      transcriptError: true,
      transcriptAttempts: true,
      createdAt: true,
    },
  });
  const enabled = voiceNoteTranscriptionEnabled();
  return new Map(
    rows.map((m) => [
      m.id,
      {
        transcript: transcriptExcerpt(transcriptText(m)),
        transcriptStatus: transcriptStatusText(m, { enabled }),
      },
    ]),
  );
}

function describeActivity(
  type: string,
  meta: Record<string, unknown>,
): string {
  switch (type) {
    case "created":
      return `Lead created${meta.manual ? " manually" : ""}${meta.source ? ` from ${meta.source}` : ""}`;
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
    case "task_completed":
      return `Completed task: ${meta.title ?? "a reminder"}`;
    case "task_cancelled":
      return `Cancelled task: ${meta.title ?? "a reminder"}`;
    case "message_sent": {
      const via = typeof meta.numberLabel === "string" ? ` via ${meta.numberLabel}` : "";
      if (meta.voiceNote === true) return `Sent a voice note${via}`;
      const channel = typeof meta.channel === "string" ? meta.channel : "a message";
      return `Sent ${channel}${via}`;
    }
    case "message_received": {
      const via = typeof meta.numberLabel === "string" ? ` on ${meta.numberLabel}` : "";
      // Phrased from the CRM's side ("received"), matching the Activity Log —
      // the actor on these rows is the guest, so "Sent…" read as if a rep had.
      if (meta.voiceNote === true) return `Voice note received${via}`;
      const channel = meta.channel === "email" ? "Email" : "WhatsApp message";
      return `${channel} received${via}`;
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
    case "booking_update": {
      // Prefer the summary — it reads as the booking as it now stands ("Double
      // occupancy with Priya Sharma · 7 days · …") rather than as a list of
      // edits. The diff is the fallback for the first save, where every field
      // moved from nothing and the summary would repeat it.
      const summary = typeof meta.summary === "string" ? meta.summary : "";
      if (summary) return `Booking details — ${summary}`;
      const changes = Array.isArray(meta.changes) ? (meta.changes as string[]) : [];
      return changes.length ? `Booking details: ${changes.join("; ")}` : "Updated booking details";
    }
    case "auto_tagged": {
      const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
      const from = meta.channel === "email" ? "their email" : "their message";
      return tags.length
        ? `Auto-tagged from ${from}: ${tags.join(", ")}`
        : `Auto-tagged from ${from}`;
    }
    case "reply_tagged": {
      const tag = typeof meta.tag === "string" ? meta.tag : "a tag";
      const ch = meta.channel === "email" ? "email" : "WhatsApp";
      return `Replied to a ${ch} broadcast — tagged "${tag}"`;
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
