"use client";

import { useRouter } from "next/navigation";
import { Phone, MessageCircle, MapPin, RefreshCw, ListChecks, Stethoscope, ClipboardList } from "lucide-react";
import { Badge, Avatar, ScoreBadge } from "@/components/ui";
import { cn, formatIST } from "@/lib/utils";
import { formatTag, sortTags } from "@/lib/lead-tags";
import { WhatsAppWindowChip } from "./whatsapp-window-chip";
import type { EnquiryDTO } from "@/lib/types";

const DOCTOR_DECISION_LABEL: Record<NonNullable<EnquiryDTO["doctorDecision"]>, string> = {
  accepted: "Accepted",
  rejected: "Rejected",
  needs_phone_consult: "Phone consult",
};

export function LeadCard({
  enquiry,
  onClick,
  dragging,
}: {
  enquiry: EnquiryDTO;
  onClick?: () => void;
  dragging?: boolean;
}) {
  const g = enquiry.guest;
  const router = useRouter();
  return (
    <div
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded-lg border bg-card p-3 shadow-sm transition-shadow hover:shadow-md",
        enquiry.needsAttention
          ? "border-l-4 border-amber-400 border-t-border border-r-border border-b-border"
          : "border-border",
        dragging && "rotate-1 opacity-90 shadow-lg ring-2 ring-primary",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 truncate text-sm font-semibold text-foreground">
          <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{g.phone ?? g.email ?? "—"}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Time left to reply in free text. Only rendered while the window
              is actually open, so its presence is the signal. */}
          {enquiry.whatsappWindow && <WhatsAppWindowChip window={enquiry.whatsappWindow} />}
          {/* A WhatsApp message this guest never got a delivery confirmation
              for. Shown on the card because the failure is otherwise
              invisible from the board — the rep would have to open the
              thread to find out nothing arrived.

              The `relative` on the badge below is required, not cosmetic:
              Tailwind's .sr-only is position:absolute with no top/left, so
              without a positioned ancestor its containing block is <html> and
              it renders at its static position — thousands of pixels down a
              scrolled column, and outside that column's overflow clip. Three
              of these badges stretched the document to 56,720px and left the
              board with a blank scroll region below the fold. */}
          {enquiry.unconfirmedMessages > 0 && (
            <span
              title={
                enquiry.unconfirmedMessages === 1
                  ? "1 WhatsApp message was never confirmed delivered — it may not have arrived"
                  : `${enquiry.unconfirmedMessages} WhatsApp messages were never confirmed delivered — they may not have arrived`
              }
              /* `relative` here is load-bearing, not styling — see the note above. */
              className="relative flex items-center gap-0.5 rounded bg-destructive/10 px-1 py-0.5 text-[10px] font-semibold leading-none text-destructive"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
              {enquiry.unconfirmedMessages}
              <span className="sr-only">unconfirmed WhatsApp messages</span>
            </span>
          )}
          {enquiry.stage === "rnr" && enquiry.rnrProgress && (
            <span
              title={`${enquiry.rnrProgress.done} of ${enquiry.rnrProgress.total} follow-up calls completed`}
              className={cn(
                "flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold leading-none",
                enquiry.rnrProgress.done >= enquiry.rnrProgress.total
                  ? "bg-brand-100 text-brand-700"
                  : enquiry.rnrProgress.done > 0
                    ? "bg-amber-100 text-amber-700"
                    : "bg-gray-100 text-gray-500",
              )}
            >
              <ListChecks className="h-3 w-3" />
              {enquiry.rnrProgress.done}/{enquiry.rnrProgress.total}
            </span>
          )}
          {enquiry.stage === "doctor_consultation" && !enquiry.doctorDecision && (
            <span
              title="Awaiting doctor's Accept/Reject/Needs-phone-consult decision"
              className="flex items-center gap-0.5 rounded bg-indigo-100 px-1 py-0.5 text-[10px] font-semibold leading-none text-indigo-700"
            >
              <Stethoscope className="h-3 w-3" />
              Needs review
            </span>
          )}
          {enquiry.doctorDecision && (
            <span
              title={
                enquiry.doctorDecisionNote
                  ? `Doctor: ${DOCTOR_DECISION_LABEL[enquiry.doctorDecision]} — ${enquiry.doctorDecisionNote}`
                  : `Doctor: ${DOCTOR_DECISION_LABEL[enquiry.doctorDecision]}`
              }
              className={cn(
                "flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold leading-none",
                enquiry.doctorDecision === "accepted"
                  ? "bg-brand-100 text-brand-700"
                  : enquiry.doctorDecision === "rejected"
                    ? "bg-rose-100 text-rose-700"
                    : "bg-amber-100 text-amber-700",
              )}
            >
              <Stethoscope className="h-3 w-3" />
              {DOCTOR_DECISION_LABEL[enquiry.doctorDecision]}
            </span>
          )}
          {enquiry.openTasks.count > 0 && (() => {
            const { count, items } = enquiry.openTasks;
            // Soonest first, so the first item decides whether anything is late.
            const overdue = Boolean(items[0]?.dueAt && new Date(items[0].dueAt) < new Date());
            const lines = items.map(
              (t) =>
                `• ${t.title}${t.dueAt ? ` — due ${formatIST(t.dueAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}`,
            );
            if (count > items.length) lines.push(`+${count - items.length} more`);
            return (
              <button
                type="button"
                /* Opens the Tasks page narrowed to this lead. stopPropagation
                   keeps the card's own click (which opens the drawer) from
                   also firing — a click on the chip means "show me these
                   tasks", not "open the lead". */
                onClick={(e) => {
                  e.stopPropagation();
                  router.push(`/tasks?lead=${enquiry.id}`);
                }}
                title={`${count} open task${count === 1 ? "" : "s"}${overdue ? " (overdue)" : ""} — click to open them in Tasks\n${lines.join("\n")}`}
                /* `relative` for the sr-only label below — see the note on the
                   unconfirmed-messages badge. */
                className={cn(
                  "relative flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold leading-none hover:brightness-95",
                  overdue ? "bg-rose-100 text-rose-700" : "bg-sky-100 text-sky-700",
                )}
              >
                <ClipboardList className="h-3 w-3" />
                {count}
                <span className="sr-only">open tasks — open in Tasks</span>
              </button>
            );
          })()}
          <ScoreBadge score={enquiry.aiScore} />
          {enquiry.needsAttention && (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
            </span>
          )}
          <MessageCircle className="h-4 w-4 text-green-600" />
        </div>
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-foreground">
          {g.fullName}
        </span>
        {enquiry.isReturningFlag ? (
          <Badge className="bg-brand-100 text-brand-700">
            <RefreshCw className="mr-1 h-3 w-3" />
            Returning
          </Badge>
        ) : null}
      </div>

      {enquiry.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {sortTags(enquiry.tags).map((t) => {
            const f = formatTag(t);
            return (
              <span
                key={t}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] font-medium",
                  f.className,
                )}
              >
                {f.label}
              </span>
            );
          })}
        </div>
      )}

      {g.city && (
        <div className="mt-1.5 flex items-center gap-0.5 text-xs text-muted-foreground">
          <MapPin className="h-3 w-3" />
          {g.city}
        </div>
      )}

      <div className="mt-2.5 flex items-center justify-between border-t border-border pt-2">
        {enquiry.assignedToName ? (
          <div className="flex items-center gap-1.5">
            <Avatar name={enquiry.assignedToName} className="h-5 w-5 text-[9px]" />
            <span className="text-xs text-muted-foreground">
              {enquiry.assignedToName}
            </span>
          </div>
        ) : (
          <span className="text-xs italic text-muted-foreground">Unassigned</span>
        )}
        <span className="text-[11px] text-muted-foreground">
          {formatIST(enquiry.lastActivityAt, {
            day: "numeric",
            month: "short",
          })}
        </span>
      </div>
    </div>
  );
}
