import type { EnquiryStage } from "@prisma/client";

/**
 * Kanban pipeline definition — derived from the Sales Flow doc.
 * Single source of truth for the board columns, their labels, colours and order.
 * Colours use the Trē brand palette (olive/green family) with intent accents.
 */
export interface StageDef {
  id: EnquiryStage;
  label: string;
  description: string;
  /** Tailwind classes for the column header accent bar / badge */
  accent: string;
  badge: string;
}

export const STAGES: StageDef[] = [
  {
    id: "new_lead",
    label: "New Lead",
    description: "Lead received — not yet contacted",
    accent: "bg-brand-300",
    badge: "bg-brand-100 text-brand-800",
  },
  {
    id: "contacted",
    label: "Contacted",
    description: "Welcome WhatsApp + email + brochure sent",
    accent: "bg-brand-400",
    badge: "bg-brand-100 text-brand-800",
  },
  // These two sit ahead of RNR: a guest who asked for a call back, or one
  // being actively worked, is further along than the not-reached cycle.
  //
  // The ids stay `pricing_shared` / `qualified` — they're a Postgres enum
  // used by every historical row, the marketing report's classifier and the
  // stage-permission rules, so renaming them would be a migration plus a
  // data rewrite for a change that is purely what staff read on the board.
  {
    id: "pricing_shared",
    label: "Call back requested",
    description: "Guest asked us to call them back — pricing/package already shared",
    accent: "bg-teal-500",
    badge: "bg-teal-100 text-teal-800",
  },
  {
    id: "qualified",
    label: "Pipeline",
    description: "Being actively worked — interest understood, conversation live",
    accent: "bg-brand-500",
    badge: "bg-brand-100 text-brand-800",
  },
  {
    id: "rnr",
    label: "RNR / Follow-up",
    description: "Responded Not Reached — in the 6-2-1 follow-up cycle",
    accent: "bg-amber-400",
    badge: "bg-amber-100 text-amber-800",
  },
  {
    id: "doctor_consultation",
    label: "Doctor Consultation",
    description: "Discovery call with the doctor scheduled / done",
    accent: "bg-indigo-400",
    badge: "bg-indigo-100 text-indigo-800",
  },
  {
    id: "payment_received",
    label: "Payment Pending",
    description: "Payment collected — awaiting booking confirmation",
    accent: "bg-cyan-500",
    badge: "bg-cyan-100 text-cyan-800",
  },
  {
    id: "booking_confirmed",
    label: "Booking Confirmed",
    description: "Booked — dates locked",
    accent: "bg-brand-600",
    badge: "bg-brand-200 text-brand-900",
  },
  {
    id: "converted",
    label: "Converted",
    description: "Checked in / stay completed",
    accent: "bg-brand-700",
    badge: "bg-brand-700 text-white",
  },
  {
    id: "staff",
    label: "Staff",
    description: "Parked with general staff — not being actively worked, not dead yet",
    accent: "bg-slate-400",
    badge: "bg-slate-100 text-slate-700",
  },
  {
    id: "non_leads",
    label: "Non-Leads",
    description: "Never a lead — spam, vendors, wrong number, internal",
    accent: "bg-zinc-400",
    badge: "bg-zinc-100 text-zinc-700",
  },
  {
    id: "lost",
    label: "Lost / Dead",
    description: "No response after 6-2-1 or not interested",
    accent: "bg-rose-400",
    badge: "bg-rose-100 text-rose-700",
  },
];

export const STAGE_MAP: Record<EnquiryStage, StageDef> = Object.fromEntries(
  STAGES.map((s) => [s.id, s]),
) as Record<EnquiryStage, StageDef>;

export const STAGE_IDS = STAGES.map((s) => s.id);

export function stageLabel(stage: EnquiryStage): string {
  return STAGE_MAP[stage]?.label ?? stage;
}
