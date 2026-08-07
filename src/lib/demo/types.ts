/**
 * Demo-mode data shapes. Deliberately close to the real Prisma models /
 * DTOs (src/lib/types.ts) so components render the same way against either
 * backend, but flattened and simplified since there's no relational DB
 * underneath — everything lives in one JSON blob in localStorage.
 */

export type AppRole = "ADMIN" | "DOCTOR" | "MANAGER" | "RECEPTION" | "SALES" | "STAFF" | "VIEWER";

export type EnquiryStage =
  | "new_lead"
  | "contacted"
  | "rnr"
  | "qualified"
  | "pricing_shared"
  | "doctor_consultation"
  | "payment_received"
  | "booking_confirmed"
  | "converted"
  | "staff"
  | "lost";

export interface DemoUser {
  sub: string;
  name: string;
  email: string;
  role: AppRole;
  phone: string;
  isOnline: boolean;
}

export interface DemoGuest {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  gender: string | null;
  city: string | null;
  ageGroup: string | null;
  tags: string[];
  isReturning: boolean;
  isBlocked: boolean;
  consentGiven: boolean;
  referralCodeUsed: string | null;
  aiReturnScore: number | null;
  aiReturnReason: string | null;
  aiNextProgram: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DemoEnquiry {
  id: string;
  guestId: string;
  stage: EnquiryStage;
  source: string;
  assignedToSub: string | null;
  assignedToName: string | null;
  packageId: string | null;
  referralCodeId: string | null;
  isReturningFlag: boolean;
  quotedPriceINR: number | null;
  proposedDates: string | null;
  lostReason: string | null;
  campaignLabel: string | null;
  intakeNotes: string | null;
  tags: string[];
  boardPosition: number;
  needsAttention: boolean;
  aiScore: number | null;
  aiScoreReason: string | null;
  aiAssist: {
    summary: string;
    nextActions: { title: string; priority: "high" | "medium" | "low"; reason: string }[];
    draft: { channel: string; subject: string; body: string };
  } | null;
  aiAssistAt: string | null;
  rnrProgress: { done: number; total: number } | null;
  doctorDecision: "accepted" | "rejected" | "needs_phone_consult" | null;
  doctorDecisionAt: string | null;
  doctorDecisionNote: string | null;
  lostRequestPending: boolean;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface DemoNote {
  id: string;
  enquiryId: string;
  authorSub: string;
  authorName: string;
  authorRole: string;
  body: string;
  createdAt: string;
}

export interface DemoActivity {
  id: string;
  enquiryId: string | null;
  guestId: string | null;
  actorSub: string;
  actorRole: string;
  actorName: string;
  actionType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DemoMessage {
  id: string;
  guestId: string | null;
  enquiryId: string | null;
  mailboxId: string;
  channel: "whatsapp" | "email" | "sms";
  direction: "inbound" | "outbound";
  subject: string | null;
  body: string;
  bodyHtml: string | null;
  fromEmail: string | null;
  toEmail: string | null;
  status: string;
  needsReview: boolean;
  fromLabel: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  /** Mirrors MessageDTO.attachment — the demo has no document table, so the
   *  file's metadata is denormalised onto the message it was sent with. */
  attachment?: { id: string; filename: string; mimeType: string } | null;
}

export interface DemoTask {
  id: string;
  enquiryId: string;
  guestName: string;
  title: string;
  dueAt: string | null;
  status: "open" | "done" | "cancelled";
  kind: "follow_up" | "doctor_review" | "deletion_approval";
  approved: boolean | null;
  assignedToSub: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DemoPackage {
  id: string;
  name: string;
  category: string;
  durationDays: number;
  basePriceINR: number;
  therapies: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DemoReferral {
  id: string;
  code: string;
  issuedToGuestId: string | null;
  campaignLabel: string | null;
  maxRedemptions: number;
  redemptionCount: number;
  isActive: boolean;
  createdAt: string;
}

export interface DemoCall {
  id: string;
  direction: "inbound" | "outbound";
  status: "initiated" | "ringing" | "connected" | "completed" | "no_answer" | "failed" | "voicemail";
  guestId: string | null;
  enquiryId: string | null;
  guestName: string;
  repKeycloakId: string | null;
  repName: string | null;
  repPhone: string | null;
  customerPhone: string;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number;
  recordingUrl: string | null;
  tags: string[];
  notes: string | null;
  transcript: string | null;
  transcriptEnglish: string | null;
  transcriptLanguage: string | null;
  aiSummary: string | null;
  aiScore: number | null;
  aiTags: string[];
  aiSuggestions: { hookLine: string; explanation: string; professionalism: string } | null;
  aiAnalyzedAt: string | null;
  createdAt: string;
}

export interface DemoTag {
  id: string;
  value: string;
  category: string;
  createdAt: string;
}

export interface DemoAiDecision {
  id: string;
  kind: "call_analysis" | "lead_scoring" | "guest_insight" | "conversation_assist" | "transcript_translation";
  callId: string | null;
  enquiryId: string | null;
  guestId: string | null;
  subjectLabel: string;
  provider: string;
  model: string;
  promptSystem: string;
  promptUser: string;
  output: Record<string, unknown> | null;
  success: boolean;
  triggeredBy: string;
  triggeredByName: string;
  createdAt: string;
}

export interface DemoWhatsAppNumber {
  id: string;
  label: string;
  phoneNumber: string | null;
  instanceName: string;
  status: "pending" | "connecting" | "connected" | "disconnected";
  isDefault: boolean;
  shared: boolean;
  integration: "baileys" | "cloud_api";
  createdAt: string;
  updatedAt: string;
}

export interface DemoAutoReply {
  id: string;
  numberId: string;
  triggerWord: string | null;
  replyText: string;
  enabled: boolean;
  createdAt: string;
}

export interface DemoMessageTemplate {
  id: string;
  channel: "email" | "whatsapp";
  name: string;
  subject: string | null;
  body: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DemoBroadcastJob {
  id: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  message: string;
  numberId: string | null;
  totalCount: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
  completedAt: string | null;
  deletedAt: string | null;
}

export interface DemoData {
  version: number;
  users: DemoUser[];
  guests: DemoGuest[];
  enquiries: DemoEnquiry[];
  notes: DemoNote[];
  activities: DemoActivity[];
  messages: DemoMessage[];
  tasks: DemoTask[];
  packages: DemoPackage[];
  referrals: DemoReferral[];
  calls: DemoCall[];
  tags: DemoTag[];
  aiDecisions: DemoAiDecision[];
  whatsappNumbers: DemoWhatsAppNumber[];
  autoReplies: DemoAutoReply[];
  messageTemplates: DemoMessageTemplate[];
  broadcastJobs: DemoBroadcastJob[];
}
