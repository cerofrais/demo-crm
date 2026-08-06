/**
 * AI/ML decision audit log — every LLM inference gets a row here, with the
 * exact prompt sent and the exact output received, independent of whatever
 * the "current" Call/Enquiry/Guest.ai* fields say after a later re-run.
 * This is what makes a past scoring/coaching/insight decision verifiable.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { aiConfig } from "./config";
import type { AiDecisionKind, Prisma } from "@prisma/client";

// F18 — decision kinds whose prompt embeds decrypted health PHI. Their raw
// prompt is NEVER persisted, even with AI_AUDIT_RAW_PROMPTS on.
const HEALTH_PHI_KINDS: ReadonlySet<AiDecisionKind> = new Set<AiDecisionKind>(["guest_insight"]);

/**
 * By default the audit log stores only a fingerprint of the user prompt
 * (sha256 + length), not the raw text — the raw prompt contains decrypted PHI
 * and full inbound email bodies. Operators can opt into raw capture for
 * debugging via AI_AUDIT_RAW_PROMPTS=true, but health-PHI kinds are always
 * redacted regardless.
 */
function fingerprintPrompt(text: string): string {
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  return `[redacted] sha256:${digest} chars:${text.length}`;
}

export interface LogAiDecisionInput {
  kind: AiDecisionKind;
  callId?: string;
  enquiryId?: string;
  guestId?: string;
  promptSystem: string;
  promptUser: string;
  output?: unknown; // JSON-serializable parsed result; omit on failure
  success: boolean;
  errorMessage?: string;
  durationMs?: number;
  /** Keycloak sub of the staff member who triggered a manual run, or "pipeline". */
  triggeredBy?: string;
  triggeredByName?: string;
}

/**
 * Best-effort write — a logging failure must never take down the actual AI
 * feature it's auditing, so this never throws.
 */
export async function logAiDecision(input: LogAiDecisionInput): Promise<void> {
  const cfg = aiConfig();
  // Persist the raw prompt only when explicitly enabled AND the record is not a
  // health-PHI kind. Otherwise store a hash+length fingerprint in the same
  // column (F18). Schema follow-up: dedicated promptUserHash/promptUserLen
  // columns would be cleaner than overloading promptUser.
  const rawEnabled = process.env.AI_AUDIT_RAW_PROMPTS === "true";
  const persistRaw = rawEnabled && !HEALTH_PHI_KINDS.has(input.kind);
  const promptUser = persistRaw ? input.promptUser : fingerprintPrompt(input.promptUser);
  try {
    await prisma.aiDecision.create({
      data: {
        kind: input.kind,
        callId: input.callId,
        enquiryId: input.enquiryId,
        guestId: input.guestId,
        provider: cfg.provider,
        model: cfg.model,
        promptSystem: input.promptSystem,
        promptUser,
        output: input.output === undefined ? undefined : (input.output as Prisma.InputJsonValue),
        success: input.success,
        errorMessage: input.errorMessage?.slice(0, 2000),
        durationMs: input.durationMs,
        triggeredBy: input.triggeredBy ?? "pipeline",
        triggeredByName: input.triggeredByName,
      },
    });
  } catch (err) {
    logger.error({ err, kind: input.kind }, "ai audit: failed to persist decision log");
  }
}
