import { prisma } from "./prisma";

export interface ActivityFilters {
  actorSub?: string;
  actionType?: string;
  dateFrom?: Date;
  dateTo?: Date;
  /** ISO createdAt of the last item on the previous page. */
  cursor?: string;
}

export interface ActivityListItemDTO {
  id: string;
  createdAt: string;
  actorSub: string;
  actorName: string;
  actorRole: string;
  actionType: string;
  actionLabel: string;
  enquiryId: string | null;
  guestName: string | null;
}

/** Human labels for known Activity.actionType values — falls back to a
 *  de-slugified version of the raw value for anything not listed here, so a
 *  newly-added actionType never renders as a blank cell. */
const ACTION_LABELS: Record<string, string> = {
  created: "Lead created",
  stage_change: "Stage changed",
  note: "Note added",
  message_sent: "Message sent",
  message_received: "Message received",
  message_edited: "Message edited",
  message_deleted: "Message deleted",
  task_created: "Task created",
  doc_upload: "Document uploaded",
  doc_download: "Document downloaded",
  assign: "Lead assigned",
  contact_update: "Contact info updated",
  health_update: "Health record updated",
  deletion_decision: "Deletion approved/denied",
  doctor_decision: "Doctor decision recorded",
  auto_deleted: "Lead auto-deleted",
  lead_revived: "Lead revived",
  call_missed: "Call missed",
  call_made: "Call made",
  call_answered: "Call answered",
  whatsapp_call_opened: "WhatsApp call log opened",
  bulk_email_sent: "Bulk email sent",
  duplicate_merged: "Duplicate submission merged",
};

export function formatActionLabel(actionType: string): string {
  return ACTION_LABELS[actionType] ?? actionType.replace(/_/g, " ");
}

/** actionType/label pairs for the filter dropdown — only the known ones,
 *  since an unlisted actionType is by definition not something a user could
 *  pick to filter on anyway. */
export const ACTION_TYPE_OPTIONS = Object.entries(ACTION_LABELS);

/** Cursor-paginated activity feed for the admin/manager Activity Log page —
 *  mirrors listAiDecisions()'s shape (same createdAt-cursor approach). */
export async function listActivity(
  filters: ActivityFilters,
  limit = 50,
): Promise<{ items: ActivityListItemDTO[]; nextCursor: string | null }> {
  const rows = await prisma.activity.findMany({
    where: {
      // Excludes every automated/system-logged Activity, same reasoning as
      // the Performance report's notSystem filter: background jobs and
      // inbound-message webhooks also write Activity rows (auto-assign,
      // auto-revive, missed calls, the dead-lead sweep), and for inbound
      // WhatsApp specifically actorName is set to the GUEST's own WhatsApp
      // display name/phone — showing that in a "Staff" column reads as if
      // the lead performed the action. This log is staff actions only.
      actorRole: { not: "system" },
      ...(filters.actorSub && { actorSub: filters.actorSub }),
      ...(filters.actionType && { actionType: filters.actionType }),
      ...((filters.dateFrom || filters.dateTo || filters.cursor) && {
        createdAt: {
          ...(filters.dateFrom && { gte: filters.dateFrom }),
          ...(filters.dateTo && { lte: filters.dateTo }),
          ...(filters.cursor && { lt: new Date(filters.cursor) }),
        },
      }),
    },
    include: {
      enquiry: { select: { id: true, guest: { select: { fullName: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  // Resolve the current display name for every actor in this page in one
  // batch, same reasoning as getStaffNamesBatch: actorName is a point-in-time
  // snapshot, so a renamed staff member's old rows should still show their
  // current name rather than looking like a different person per page.
  const subs = Array.from(new Set(items.map((r) => r.actorSub)));
  const staff = await prisma.staffProfile.findMany({
    where: { keycloakId: { in: subs } },
    select: { keycloakId: true, displayName: true },
  });
  const nameBySub = new Map(staff.map((s) => [s.keycloakId, s.displayName]));

  return {
    items: items.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      actorSub: r.actorSub,
      actorName: nameBySub.get(r.actorSub) ?? r.actorName ?? "Unknown",
      actorRole: r.actorRole,
      actionType: r.actionType,
      actionLabel: formatActionLabel(r.actionType),
      enquiryId: r.enquiryId,
      guestName: r.enquiry?.guest?.fullName ?? null,
    })),
    nextCursor: hasMore ? items[items.length - 1].createdAt.toISOString() : null,
  };
}
