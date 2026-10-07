/**
 * Lead conversion scoring — ranks open enquiries by conversion likelihood
 * using goal, package interest, source, engagement and recency signals.
 * Re-scores when the lead has had activity since the last score.
 */
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { chatJSON } from "./provider";
import { logAiDecision } from "./audit";
import { DATA_FENCE_RULES, fence, llmNumber, llmString, parseLlm } from "./safety";

const SYSTEM = `You score sales leads for Trē Wellness, an Ayurvedic wellness retreat in India.
Given one lead's context, estimate conversion likelihood 0-100 and explain in one sentence.
Signals that raise the score: returning guest, referral source, doctor consultation done or booked,
price quoted and engaged with, recent inbound replies, high-intent tags, clear wellness goal.
Signals that lower it: long silence, RNR stage, price objections, no contact details, vague interest.
Be decisive — spread scores across the range, do not cluster around 50.
${DATA_FENCE_RULES}`;

// F36 — validate/clamp the model's JSON before it becomes the Kanban score.
const scoreSchema = z.object({
  score: llmNumber({ def: 0, min: 0, max: 100 }),
  reason: llmString(500),
});
type ScoreResult = z.infer<typeof scoreSchema>;

export async function scoreEnquiry(enquiryId: string): Promise<void> {
  const e = await prisma.enquiry.findUnique({
    where: { id: enquiryId },
    include: {
      guest: { select: { fullName: true, city: true, isReturning: true, email: true, phone: true } },
      package: { select: { name: true, basePriceINR: true } },
      notes: { orderBy: { createdAt: "desc" }, take: 5, select: { body: true } },
      messages: {
        orderBy: { createdAt: "desc" }, take: 6,
        select: { direction: true, createdAt: true, subject: true },
      },
      calls: {
        orderBy: { startedAt: "desc" }, take: 3,
        select: { status: true, durationSec: true, aiSummary: true, notes: true },
      },
    },
  });
  if (!e) return;

  const daysSinceActivity = Math.round((Date.now() - e.lastActivityAt.getTime()) / 86_400_000);
  const prompt = [
    `Lead: ${e.guest.fullName} (${e.guest.city ?? "-"}) — ${e.guest.isReturning ? "RETURNING guest" : "new"}`,
    `Stage: ${e.stage} · Source: ${e.source} · Tags: ${e.tags.join(", ") || "none"}`,
    `Quoted: ${e.quotedPriceINR ? `₹${e.quotedPriceINR}` : "no"} · Package: ${e.package?.name ?? "-"}`,
    `Contact: ${e.guest.phone ? "phone" : ""}${e.guest.email ? " email" : ""}`.trim() || "Contact: none",
    `Days since last activity: ${daysSinceActivity}`,
    // F37 — email subjects are attacker-controlled inbound text: fence each one
    // as DATA so a crafted subject can't steer the score. Notes are fenced
    // separately so an auto-generated "inbound email" note stays decoupled from
    // (and never re-inlines) the raw subject as a bare prompt line.
    "Recent email subjects (untrusted inbound content):",
    e.messages.length
      ? e.messages
          .map((m, i) => fence("SUBJECT", m.subject ?? "-", { i: i + 1, direction: m.direction }))
          .join("\n")
      : "none",
    `Recent calls: ${e.calls.map((c) => `${c.status} ${Math.round(c.durationSec / 60)}min ${c.aiSummary ?? c.notes ?? ""}`.trim()).join(" | ") || "none"}`,
    "Recent notes:",
    e.notes.length
      ? e.notes.map((n, i) => fence("NOTE", n.body.slice(0, 150), { i: i + 1 })).join("\n")
      : "none",
    "",
    `Return JSON: {"score": number, "reason": string}`,
  ].join("\n");

  // Generous budget: thinking models spend most tokens on reasoning first.
  const t0 = Date.now();
  let result: ScoreResult;
  try {
    // Validate/clamp before it lands on the enquiry (F36).
    result = parseLlm(scoreSchema, await chatJSON<unknown>(SYSTEM, prompt, { maxTokens: 1500 }));
  } catch (err) {
    await logAiDecision({
      kind: "lead_scoring",
      enquiryId: e.id,
      promptSystem: SYSTEM,
      promptUser: prompt,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    });
    throw err;
  }

  await prisma.enquiry.update({
    where: { id: e.id },
    data: {
      aiScore: Math.max(0, Math.min(100, Math.round(result.score))),
      aiScoreReason: result.reason?.slice(0, 500) ?? null,
      aiScoredAt: new Date(),
    },
  });
  await logAiDecision({
    kind: "lead_scoring",
    enquiryId: e.id,
    promptSystem: SYSTEM,
    promptUser: prompt,
    output: result,
    success: true,
    durationMs: Date.now() - t0,
  });
}

/** Batch step: score never-scored or stale (activity since last score) open leads. */
export async function runLeadScoring(limit = 8): Promise<number> {
  const open = await prisma.enquiry.findMany({
    where: { stage: { notIn: ["converted", "lost", "non_leads"] } },
    select: { id: true, aiScoredAt: true, lastActivityAt: true },
    take: 500,
  });

  const candidates = open
    .filter((e) => !e.aiScoredAt || e.aiScoredAt < e.lastActivityAt)
    .sort((a, b) => (a.aiScoredAt?.getTime() ?? 0) - (b.aiScoredAt?.getTime() ?? 0))
    .slice(0, limit);

  let done = 0;
  for (const { id } of candidates) {
    try {
      await scoreEnquiry(id);
      done++;
    } catch (err) {
      logger.error({ err, enquiryId: id }, "ai: lead scoring failed");
    }
  }
  return done;
}
