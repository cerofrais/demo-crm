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
  isReturning: boolean;
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
  /** Doctor's Accept/Reject/Needs-phone-consult call on a consultation-stage lead. */
  doctorDecision: "accepted" | "rejected" | "needs_phone_consult" | null;
  doctorDecisionAt: string | null;
  doctorDecisionNote: string | null;
  /** An open, undecided "move to Lost/Dead" request exists for this lead. */
  lostRequestPending: boolean;
}

export interface MessageDTO {
  id: string;
  direction: "inbound" | "outbound";
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
  /** Outbound WhatsApp only — the connected number's label (e.g. "Sales
   * Line"), resolved from mailboxId. Lets the thread show which number a
   * message went out from instead of a generic "You". */
  fromLabel: string | null;
  /** CRM-side correction/redaction tag — never touches WhatsApp itself. */
  editedAt: string | null;
  deletedAt: string | null;
}

export interface TimelineItemDTO {
  id: string;
  kind: "activity" | "note";
  actorName: string;
  /** Only populated for "note" items — the author's primary role at write
   *  time (e.g. "ADMIN"), used to style an admin's remark differently. */
  actorRole?: string | null;
  text: string;
  createdAt: string;
  meta?: Record<string, unknown>;
  /** Only populated for "note" items with a voice note or file attached. */
  attachment?: { id: string; filename: string; mimeType: string; sizeBytes: number } | null;
}
