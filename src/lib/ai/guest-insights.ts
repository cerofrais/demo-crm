/**
 * Guest insights — for guests with completed stays (converted enquiries),
 * score return likelihood, recommend the next programme from their health
 * profile + stay history, and auto-create a timed outreach task when the
 * return likelihood is high.
 */
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { decryptJson, type EncryptedBlob } from "@/lib/crypto";
import type { HealthRecord } from "@/lib/health";
import { chatJSON } from "./provider";
import { logAiDecision } from "./audit";
import { aiAllowExternalHealth, isLoopbackAiBaseUrl } from "./config";
import { llmNumber, llmString, parseLlm } from "./safety";

const SYSTEM = `You analyse past guests of Trē Wellness, an Ayurvedic wellness retreat in India.
Given a guest's stay history, health profile and membership, produce:
1. returnScore 0-100 — likelihood they will book another stay in the next 12 months.
   Returning guests, active memberships with unused credits, chronic conditions needing
   maintenance, and positive engagement all raise the score.
2. reason — one sentence.
3. nextProgram — the single best programme to offer next, grounded in their health profile
   and past stays (e.g. "7-Day Residential Detox with cardiac wellness overlay").
4. outreachInDays — when to reach out (7-90 days; sooner for high scores or expiring credits).`;

// F36 — validate the model's JSON before it reaches Prisma: coerce/clamp the
// score + outreach window (no more NaN dates) and cap the free-text fields.
const insightSchema = z.object({
  returnScore: llmNumber({ def: 0, min: 0, max: 100 }),
  reason: llmString(500),
  nextProgram: llmString(120),
  outreachInDays: llmNumber({ def: 30, min: 1, max: 365 }),
});
type InsightResult = z.infer<typeof insightSchema>;

const OUTREACH_PREFIX = "AI outreach:";

/**
 * F17 — coarse-redact a decrypted health profile into non-identifying boolean
 * flags. Used whenever the health data would leave the local host so raw
 * diagnoses / medications / diet notes are never sent to an external endpoint.
 */
function coarseHealth(rec: HealthRecord): string {
  const chronic = [
    rec.heartDisease?.flag,
    rec.kidneyLiverLung?.flag,
    rec.seizures?.flag,
    rec.psychiatricHistory?.flag,
  ].some(Boolean);
  const hasAllergies = (rec.allergies ?? []).some((a) => a && a !== "None");
  return [
    `has_health_issues: ${Boolean(rec.hasHealthIssues || rec.healthIssues?.trim())}`,
    `has_chronic_condition: ${chronic}`,
    `on_medication: ${Boolean(rec.medications?.trim())}`,
    `has_allergies: ${hasAllergies}`,
    // purpose of visit is a coarse category (Detox/Healing/…), not a diagnosis
    `visit_purpose: ${rec.purposeOfVisit || "-"}`,
  ].join("; ");
}

export async function generateGuestInsight(guestId: string): Promise<void> {
  const guest = await prisma.guest.findUnique({
    where: { id: guestId },
    include: {
      enquiries: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true, stage: true, createdAt: true, quotedPriceINR: true, tags: true,
          package: { select: { name: true, durationDays: true } },
          assignedToSub: true,
        },
      },
      memberships: { where: { status: "active" } },
      healthProfiles: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!guest) return;

  // F17 — PHI egress gate. When the chat endpoint is not loopback we only run
  // if the operator explicitly opted in, and even then we redact: raw health
  // data (and identifiers like name/city) must never be sent off-box.
  const loopback = isLoopbackAiBaseUrl();
  if (!loopback && !aiAllowExternalHealth()) {
    logger.warn(
      { guestId },
      "ai: guest insights skipped — AI_BASE_URL is external and AI_ALLOW_EXTERNAL_HEALTH is not set",
    );
    return;
  }
  const redactPhi = !loopback; // going off-box → coarse flags + no identifiers

  // Decrypt the health profile (best effort — key may differ across envs).
  let health = "none on file";
  // Only the first record: the AI summary describes the guest, and a
  // family member's record attached to the same phone is not about them.
  const primaryHealth = guest.healthProfiles[0];
  if (primaryHealth) {
    try {
      const rec = decryptJson<HealthRecord>({
        ciphertext: primaryHealth.encryptedData,
        iv: primaryHealth.iv,
        authTag: primaryHealth.authTag,
      } as EncryptedBlob);
      health = redactPhi
        ? coarseHealth(rec)
        : [
            rec.healthIssues && `issues: ${rec.healthIssues}`,
            rec.medications && `medications: ${rec.medications}`,
            rec.purposeOfVisit && `visit purpose: ${rec.purposeOfVisit}`,
            rec.dietNotes && `diet: ${rec.dietNotes}`,
          ].filter(Boolean).join("; ") || "on file, unremarkable";
    } catch {
      health = "on file (not readable)";
    }
  }

  const stays = guest.enquiries.filter((e) => e.stage === "converted" || e.stage === "booking_confirmed");
  const prompt = [
    // Identifiers (name/city) are dropped when sending off-box.
    redactPhi
      ? `Guest: (identity withheld) — returning flag: ${guest.isReturning}`
      : `Guest: ${guest.fullName} (${guest.city ?? "-"}) — returning flag: ${guest.isReturning}`,
    `Stays / bookings: ${stays.map((s) => `${s.package?.name ?? "?"} (${s.createdAt.toISOString().slice(0, 10)}, ₹${s.quotedPriceINR ?? "?"})`).join(" | ") || "none completed"}`,
    `All enquiries: ${guest.enquiries.map((e) => `${e.stage}`).join(", ")}`,
    `Active memberships: ${guest.memberships.map((m) => `${m.planName} — ${m.creditsTotal - m.creditsUsed}/${m.creditsTotal} credits left, expires ${m.expiryDate.toISOString().slice(0, 10)}`).join(" | ") || "none"}`,
    `Health profile: ${health}`,
    `Tags: ${guest.tags.join(", ") || "none"}`,
    "",
    `Return JSON: {"returnScore": number, "reason": string, "nextProgram": string, "outreachInDays": number}`,
  ].join("\n");

  // Generous budget: thinking models spend most tokens on reasoning first.
  const t0 = Date.now();
  let result: InsightResult;
  try {
    // Validate/clamp the model's JSON (F36) rather than trusting an `as` cast.
    result = parseLlm(insightSchema, await chatJSON<unknown>(SYSTEM, prompt, { maxTokens: 1500 }));
  } catch (err) {
    await logAiDecision({
      kind: "guest_insight",
      guestId: guest.id,
      promptSystem: SYSTEM,
      promptUser: prompt,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    });
    throw err;
  }
  await logAiDecision({
    kind: "guest_insight",
    guestId: guest.id,
    promptSystem: SYSTEM,
    promptUser: prompt,
    output: result,
    success: true,
    durationMs: Date.now() - t0,
  });
  const score = Math.max(0, Math.min(100, Math.round(result.returnScore)));

  await prisma.guest.update({
    where: { id: guest.id },
    data: {
      aiReturnScore: score,
      aiReturnReason: result.reason?.slice(0, 500) ?? null,
      aiNextProgram: result.nextProgram?.slice(0, 300) ?? null,
      aiInsightAt: new Date(),
    },
  });

  // High likelihood → schedule an outreach follow-up on the latest enquiry,
  // unless an open AI-outreach task already exists for it.
  const latest = guest.enquiries[0];
  if (score >= 70 && latest) {
    const existing = await prisma.task.count({
      where: { enquiryId: latest.id, status: "open", title: { startsWith: OUTREACH_PREFIX } },
    });
    if (existing === 0) {
      const days = Math.max(7, Math.min(90, Math.round(result.outreachInDays || 30)));
      await prisma.task.create({
        data: {
          enquiryId: latest.id,
          title: `${OUTREACH_PREFIX} offer ${result.nextProgram?.slice(0, 120) ?? "next programme"}`,
          dueAt: new Date(Date.now() + days * 86_400_000),
          assignedToSub: latest.assignedToSub,
          createdBy: "ai-pipeline",
        },
      });
      logger.info({ guestId, days, score }, "ai: outreach task scheduled");
    }
  }
}

/** Batch step: guests with a converted/booked stay and no fresh insight (30-day TTL). */
export async function runGuestInsights(limit = 5): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const guests = await prisma.guest.findMany({
    where: {
      deletedAt: null,
      enquiries: { some: { stage: { in: ["converted", "booking_confirmed"] } } },
      OR: [{ aiInsightAt: null }, { aiInsightAt: { lt: cutoff } }],
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: { id: true },
  });

  let done = 0;
  for (const { id } of guests) {
    try {
      await generateGuestInsight(id);
      done++;
    } catch (err) {
      logger.error({ err, guestId: id }, "ai: guest insight failed");
    }
  }
  return done;
}
