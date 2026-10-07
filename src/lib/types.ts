import type { EnquiryStage } from "@prisma/client";

/** Serializable shape sent to the client (no Date objects, no PII beyond need). */
export interface GuestDTO {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  gender: string | null;
  ageGroup: string | null;
  /** Has stayed with us before — see lib/guest-visits.ts. */
  isReturning: boolean;
  /** Whether a health record exists; null when the query didn't check. */
  hasHealthRecord?: boolean | null;
  tags: string[];
}

export interface AssistNextActionDTO {
  title: string;
  priority: "high" | "medium" | "low";
  reason: string;
}

export interface AssistResultDTO {
  summary: string;
  nextActions: AssistNextActionDTO[];
  draft: { channel: string; subject: string; body: string };
}

export interface EnquiryDTO {
  id: string;
  stage: EnquiryStage;
  source: string;
  assignedToSub: string | null;
  assignedToName: string | null;
  isReturningFlag: boolean;
  quotedPriceINR: number | null;
  campaignLabel: string | null;
  /** Free-text captured at intake (e.g. lead-gen form Q&A) — distinct from the remarks timeline. */
  intakeNotes: string | null;
  /** Check-in date the guest asked for at intake. ISO; date-only in meaning. */
  preferredCheckIn: string | null;
  /** Booking detail filled in by a rep on the drawer. All optional and
   *  independent; most leads have none of it. `companionName` is only
   *  collected for double occupancy. */
  occupancy: "single" | "double" | null;
  companionName: string | null;
  stayDays: number | null;
  roomCount: number | null;
  pricePerDayINR: number | null;
  roomCategory: "premium" | "executive" | null;
  boardPosition: number;
  needsAttention: boolean;
  aiScore: number | null;
  aiScoreReason: string | null;
  aiAssist: AssistResultDTO | null;
  aiAssistAt: string | null;
  tags: string[];
  lastActivityAt: string;
  createdAt: string;
  guest: GuestDTO;
  /** Progress on the 3 auto-scheduled RNR follow-up calls, only while in RNR. */
  rnrProgress: { done: number; total: number } | null;
  /** Outbound WhatsApp messages this guest never got a delivery confirmation
   *  for. Surfaced on the lead so a rep sees it without opening the thread —
   *  these usually did fail, and the failure is otherwise invisible. */
  unconfirmedMessages: number;
  /** Doctor's Accept/Reject/Needs-phone-consult call on a consultation-stage lead. */
  doctorDecision: "accepted" | "rejected" | "needs_phone_consult" | null;
  doctorDecisionAt: string | null;
  doctorDecisionNote: string | null;
  /** An open, undecided "move to Lost/Dead" request exists for this lead. */
  lostRequestPending: boolean;
  /** Open tasks on this lead: the true count plus the soonest-due few.
   *  Drives the task icon on the card. */
  openTasks: {
    count: number;
    items: { id: string; title: string; dueAt: string | null; kind: string }[];
  };
  /** Meta's 24-hour customer-service window, when one is currently open on
   *  this guest — i.e. they messaged one of our numbers within the last 24h,
   *  so a rep may still reply in free text. Null once it has closed, which is
   *  when a reply needs an approved template instead and a free-text send is
   *  refused with error 131047. Meta counts the window per NUMBER, so
   *  `ourNumber` names the only line the window is open on. */
  whatsappWindow: { expiresAt: string; ourNumber: string | null } | null;
}

export interface MessageDTO {
  id: string;
  direction: "inbound" | "outbound";
  /** Meta's approved template this was sent as, shown beside the words it
   *  said. Null for an ordinary message. */
  metaTemplateName?: string | null;
  mailboxId: string;
  subject: string | null;
  body: string;
  bodyHtml: string | null;
  fromEmail: string | null;
  toEmail: string | null;
  status: string;
  needsReview: boolean;
  createdAt: string;
  attachment: { id: string; filename: string; mimeType: string } | null;
  /** Every attachment the email carried, by filename — received ones too,
   *  whose files are not stored. Drives the paperclip on the message. */
  attachmentNames?: string[];
  /** WhatsApp voice notes: what was said. `transcript` is the native script,
   *  `transcriptEnglish` the translation staff read. Both null until the
   *  background pass has run — see lib/ai/voice-note-transcribe.ts. */
  transcript?: string | null;
  transcriptEnglish?: string | null;
  transcriptLanguage?: string | null;
  /** What to show instead while there is no transcript ("Transcribing…", or
   *  why there will never be one). Null when there's nothing to say — it is
   *  computed server-side because only the server knows whether this
   *  deployment has a speech-to-text endpoint at all. */
  transcriptStatus?: string | null;
  /** Outbound WhatsApp only — the connected number's label (e.g. "Sales
   * Line"), resolved from mailboxId. Lets the thread show which number a
   * message went out from instead of a generic "You". */
  fromLabel: string | null;
  /** Sending number's integration — see isStatusStale. */
  integration: string | null;
  /** CRM-side correction/redaction tag — never touches WhatsApp itself. */
  editedAt: string | null;
  deletedAt: string | null;
  /** WhatsApp only — the message this one was sent as a reply to, resolved
   * from the quoted id. Null when it isn't a reply, or when the quoted message
   * predates this conversation in the CRM (WhatsApp lets you reply to
   * anything, including messages we never stored). */
  replyTo: { id: string; body: string; direction: "inbound" | "outbound" } | null;
}

export interface TimelineItemDTO {
  id: string;
  kind: "activity" | "note";
  /** Raw Activity.actionType — only on "activity" items. Lets the client
   *  recognise specific entries (e.g. task_created, which links to the task)
   *  instead of pattern-matching the rendered sentence. */
  actionType?: string | null;
  actorName: string;
  /** Only populated for "note" items — the author's primary role at write
   *  time (e.g. "ADMIN"), used to style an admin's remark differently. */
  actorRole?: string | null;
  /** Only on "note" items: "remark" (the working record, which the Cresent
   *  report shows the client) or "comment" (internal, left out of it). */
  noteKind?: "remark" | "comment";
  text: string;
  createdAt: string;
  meta?: Record<string, unknown>;
  /** Only populated for "note" items with a voice note or file attached. */
  attachment?: { id: string; filename: string; mimeType: string; sizeBytes: number } | null;
}
