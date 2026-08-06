/**
 * Conversation helper agent — reads everything we know about a lead
 * (profile, stage, notes, email thread, calls, open tasks) and suggests
 * what to do next plus a ready-to-send draft reply.
 */
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { chatJSON } from "./provider";
import { logAiDecision } from "./audit";
import { DATA_FENCE_RULES, fence, llmString, parseLlm } from "./safety";

export interface AssistNextAction {
  title: string;
  priority: "high" | "medium" | "low";
  reason: string;
}

export interface AssistResult {
  summary: string;
  nextActions: AssistNextAction[];
  draft: { channel: "email"; subject: string; body: string };
}

const SYSTEM = `You are a sales assistant for Trē Wellness, an Ayurvedic wellness retreat in India.
Your job: help the sales rep convert this lead. You will receive the full context of one lead.
Produce:
1. summary — 2-3 sentences: where this lead stands and what they are waiting on.
2. nextActions — 2-4 concrete actions ranked by priority ("high"|"medium"|"low"), each with a one-line reason. Actions must be specific ("Send revised quote including doctor consultation", not "follow up").
3. draft — a ready-to-send email reply (subject + body) responding to the most recent open thread, or a proactive check-in if nothing is pending. Warm, professional, concise (under 150 words), signed off with the rep's name. Never invent prices or dates not present in the context.
${DATA_FENCE_RULES}`;

// F36 — validate/cap the model's JSON before it is persisted to enquiry.aiAssist
// and rendered in the drawer (no unbounded titles / injected structure).
const assistSchema = z.object({
  summary: llmString(2000),
  nextActions: z
    .array(
      z.object({
        title: llmString(160),
        priority: z.enum(["high", "medium", "low"]).catch("medium"),
        reason: llmString(300),
      }),
    )
    .catch([])
    .transform((a) => a.slice(0, 6)),
  draft: z
    .object({
      channel: z.literal("email").catch("email"),
      subject: llmString(200),
      body: llmString(4000),
    })
    .catch({ channel: "email" as const, subject: "", body: "" }),
});

export async function getAssist(
  enquiryId: string,
  repName: string,
  triggeredBy?: string,
): Promise<AssistResult> {
  const enquiry = await prisma.enquiry.findUnique({
    where: { id: enquiryId },
    include: {
      guest: true,
      package: { select: { name: true, basePriceINR: true, durationDays: true } },
      notes: { orderBy: { createdAt: "desc" }, take: 10 },
      messages: { orderBy: { createdAt: "desc" }, take: 12 },
      calls: {
        orderBy: { startedAt: "desc" },
        take: 5,
        select: {
          direction: true, status: true, durationSec: true, startedAt: true,
          notes: true, aiSummary: true,
        },
      },
      tasks: { where: { status: "open" }, orderBy: { dueAt: "asc" }, take: 8 },
    },
  });
  if (!enquiry) throw new Error("Enquiry not found");

  const g = enquiry.guest;
  const lines: string[] = [
    `LEAD: ${g.fullName} (${g.city ?? "city unknown"}, ${g.gender ?? "-"}) — ${g.isReturning ? "RETURNING guest" : "new lead"}`,
    `Stage: ${enquiry.stage} · Source: ${enquiry.source} · Quoted: ${enquiry.quotedPriceINR ? `₹${enquiry.quotedPriceINR}` : "not quoted"}`,
    `Package of interest: ${enquiry.package ? `${enquiry.package.name} (${enquiry.package.durationDays}d, ₹${enquiry.package.basePriceINR})` : "none"}`,
    `Tags: ${enquiry.tags.join(", ") || "none"}`,
    `Rep handling this lead: ${repName}`,
  ];

  if (enquiry.tasks.length) {
    lines.push("", "OPEN TASKS:");
    for (const t of enquiry.tasks) {
      lines.push(`- ${t.title}${t.dueAt ? ` (due ${t.dueAt.toISOString().slice(0, 10)})` : ""}`);
    }
  }

  if (enquiry.calls.length) {
    lines.push("", "RECENT CALLS (newest first):");
    for (const c of enquiry.calls) {
      lines.push(
        `- ${c.startedAt.toISOString().slice(0, 10)} ${c.direction} ${c.status} ${Math.round(c.durationSec / 60)}min — ${c.aiSummary ?? c.notes ?? "no notes"}`,
      );
    }
  }

  // F16 — notes and inbound email are attacker-controlled: wrap each in a typed
  // DATA fence (with fence-forging neutralised) so the model treats the text as
  // information, never as instructions that could plant a fraudulent draft.
  if (enquiry.notes.length) {
    lines.push("", "INTERNAL NOTES (newest first):");
    enquiry.notes.forEach((n, i) => {
      lines.push(fence("NOTE", n.body.slice(0, 300), { id: i + 1, author: n.authorName ?? n.authorSub ?? "staff" }));
    });
  }

  if (enquiry.messages.length) {
    lines.push("", "EMAIL THREAD (newest first):");
    enquiry.messages.forEach((m, i) => {
      lines.push(
        fence(
          "MESSAGE",
          `Subject: ${m.subject ?? "(no subject)"}\n${m.body.slice(0, 800)}`,
          { id: i + 1, direction: m.direction, at: m.createdAt.toISOString().slice(0, 16) },
        ),
      );
    });
  }

  lines.push(
    "",
    `Return JSON: {"summary": string, "nextActions": [{"title": string, "priority": "high"|"medium"|"low", "reason": string}], "draft": {"channel": "email", "subject": string, "body": string}}`,
  );
  const userPrompt = lines.join("\n");

  const t0 = Date.now();
  let result: AssistResult;
  try {
    // Validate/cap the model output before persisting/returning it (F36).
    result = parseLlm(assistSchema, await chatJSON<unknown>(SYSTEM, userPrompt, { maxTokens: 3000 }));
  } catch (err) {
    await logAiDecision({
      kind: "conversation_assist",
      enquiryId,
      guestId: g.id,
      promptSystem: SYSTEM,
      promptUser: userPrompt,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
      triggeredBy,
      triggeredByName: repName,
    });
    throw err;
  }
  await logAiDecision({
    kind: "conversation_assist",
    enquiryId,
    guestId: g.id,
    promptSystem: SYSTEM,
    promptUser: userPrompt,
    output: result,
    success: true,
    durationMs: Date.now() - t0,
    triggeredBy,
    triggeredByName: repName,
  });

  // Persist so the drawer shows the saved result on reopen — only
  // regenerated when the rep explicitly clicks Generate/Regenerate again.
  await prisma.enquiry.update({
    where: { id: enquiryId },
    data: { aiAssist: result as object, aiAssistAt: new Date() },
  });

  return result;
}
