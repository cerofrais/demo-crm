/**
 * AI call analysis — transcribe the recording (when a whisper endpoint is
 * configured), then score / tag / coach the call with the chat model.
 * Runs in the background pipeline; can also be triggered per-call from the UI.
 */
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { fetchRecording } from "@/lib/plivo";
import { chatJSON } from "./provider";
import { transcribeAudio, transcriptionEnabled } from "./transcribe";
import { reconcileTranscript, type TranscriptAttempt } from "./transcript-translate";
import { asrLanguages } from "./config";
import { collapseRepetitions, isUsableTranscript } from "./transcript-quality";
import { logAiDecision } from "./audit";
import {
  canTranscribeNow,
  isTranscribableStatus,
  MAX_TRANSCRIPT_ATTEMPTS,
  pendingCallsWhere,
} from "./call-analysis-queue";
import { DATA_FENCE_RULES, fence, llmNumber, llmString, llmStringArray, parseLlm } from "./safety";

export interface CallCoaching {
  hookLine: string;
  explanation: string;
  professionalism: string;
  nextSteps: string;
}

// F36 — validate/clamp the model's JSON before it reaches the call record.
const analysisSchema = z.object({
  summary: llmString(2000),
  score: llmNumber({ def: 0, min: 0, max: 100 }),
  tags: llmStringArray(8, 60),
  suggestions: z
    .object({
      hookLine: llmString(600),
      explanation: llmString(600),
      professionalism: llmString(600),
      nextSteps: llmString(600),
    })
    .catch({ hookLine: "", explanation: "", professionalism: "", nextSteps: "" }),
});
type AnalysisResult = z.infer<typeof analysisSchema>;

const SYSTEM = `You are a sales-call quality coach for Trē Wellness, an Ayurvedic wellness retreat in India.
You review calls between sales reps and prospective guests.
Score the call 0-100 on overall quality (rapport, discovery, clarity, closing).
Extract 2-5 short kebab-case tags describing the call (e.g. "pricing-discussed", "objection-price", "booking-intent").
Give concrete coaching in four areas:
- hookLine: how the rep opened the call and a better opening line if needed
- explanation: how clearly the programme/pricing was explained, with one improvement
- professionalism: tone, empathy, listening — one concrete observation
- nextSteps: whether a clear next action was agreed, and what the rep should do now
Also write a 2-3 sentence summary a manager can read at a glance.
Be specific and reference actual moments from the call. Keep every field under 60 words.
${DATA_FENCE_RULES}`;

function analysisPrompt(input: {
  direction: string;
  durationSec: number;
  repName: string | null;
  guestName: string | null;
  stage: string | null;
  transcript: string | null;
  notes: string | null;
}): string {
  // Transcript / notes are untrusted (transcribed speech): fence them as DATA.
  const src = input.transcript
    ? `CALL TRANSCRIPT:\n${fence("TRANSCRIPT", input.transcript.slice(0, 12_000))}`
    : `No transcript is available. Analyse based on the rep's call notes:\n${fence("CALL_NOTES", input.notes)}`;
  return [
    `Direction: ${input.direction}`,
    `Duration: ${Math.round(input.durationSec / 60)}m ${input.durationSec % 60}s`,
    `Rep: ${input.repName ?? "unknown"}`,
    `Guest: ${input.guestName ?? "unknown"}`,
    `Lead stage: ${input.stage ?? "unknown"}`,
    "",
    src,
    "",
    `Return JSON: {"summary": string, "score": number, "tags": string[], "suggestions": {"hookLine": string, "explanation": string, "professionalism": string, "nextSteps": string}}`,
  ].join("\n");
}

/**
 * Analyse one call. `force` re-analyses even if aiAnalyzedAt is set.
 * Returns the reason a call was skipped, or null on success.
 */
export async function analyzeCall(
  callId: string,
  force = false,
  triggeredBy?: string,
  triggeredByName?: string,
): Promise<string | null> {
  const call = await prisma.call.findUnique({
    where: { id: callId },
    include: {
      guest: { select: { fullName: true } },
      enquiry: { select: { stage: true } },
    },
  });
  if (!call) return "call not found";
  if (call.aiAnalyzedAt && !force) return "already analysed";

  // 1) Get a transcript: existing → transcribe recording (once per candidate
  // language, reconciled + translated to English) → fall back to notes.
  // Gated on transcriptEnglish rather than transcript so a call transcribed
  // before this feature existed (native script only, no translation) gets
  // upgraded the next time it's processed.
  let transcript = call.transcript;
  let transcriptEnglish = call.transcriptEnglish;

  // Whether this recording can hold a conversation at all — see
  // TRANSCRIBABLE_STATUSES. A no_answer recording is ringing only, and
  // records that fact once rather than being re-tried forever.
  const transcribableAudio = isTranscribableStatus(call.status);
  if (!transcribableAudio && call.recordingUrl && !call.transcriptError) {
    await prisma.call.update({
      where: { id: call.id },
      data: { transcriptError: "the call was never answered — the recording is ringing only" },
    }).catch(() => null);
  }
  if (!transcriptEnglish && transcriptionEnabled() && canTranscribeNow(call)) {
    // Counted before the work: a decode that hangs or crashes the process
    // must still cost an attempt, or the call is retried forever.
    await prisma.call.update({
      where: { id: call.id },
      data: { transcriptAttempts: { increment: 1 }, transcriptAttemptAt: new Date() },
    });
    const upstream = await fetchRecording(call.recordingUrl!);
    if (upstream.ok) {
      const audio = await upstream.arrayBuffer();
      const attempts: TranscriptAttempt[] = [];
      for (const lang of asrLanguages()) {
        try {
          const text = await transcribeAudio(audio, `call-${call.id}.mp3`, lang);
          // A dead decode returns "" or a couple of syllables rather than an
          // error. Drop it here so it never counts as a usable attempt.
          if (isUsableTranscript(text)) {
            attempts.push({ language: lang ?? "auto", text });
          } else {
            logger.warn(
              { callId, lang, chars: text.trim().length },
              "ai: transcription attempt returned no usable speech",
            );
          }
        } catch (err) {
          logger.warn({ callId, lang, err }, "ai: transcription attempt failed");
        }
      }
      if (attempts.length) {
        const reconciled = await reconcileTranscript(attempts, {
          callId: call.id,
          enquiryId: call.enquiryId ?? undefined,
        });
        if (reconciled) {
          transcript = collapseRepetitions(reconciled.nativeText);
          transcriptEnglish = collapseRepetitions(reconciled.englishText);
          await prisma.call.update({
            where: { id: call.id },
            data: {
              transcript,
              transcriptEnglish,
              transcriptLanguage: reconciled.language,
              transcriptError: null,
            },
          });
        } else {
          await noteTranscriptFailure(call.id, "the transcript couldn't be recovered from the audio");
          logger.warn({ callId }, "ai: transcript unrecoverable, leaving call untranscribed");
        }
      } else {
        await noteTranscriptFailure(call.id, "no speech was recognised in the recording");
        logger.warn({ callId }, "ai: all transcription attempts failed");
      }
    } else {
      // 401/403 is OUR problem, not this recording's: the Plivo credentials
      // don't cover the account holding it (recordings from before the 20 Aug
      // account change live on the old one). The attempt still counts —
      // refunding it would mean retrying forever, which is the exact loop
      // this whole change exists to remove. Fixing the credential is an
      // operator action, and so is the reset that follows it:
      //   UPDATE "Call" SET "transcriptAttempts" = 0, "transcriptError" = NULL
      //   WHERE "transcriptError" LIKE '%provider refused%';
      const systemic = upstream.status === 401 || upstream.status === 403 || upstream.status >= 500;
      await noteTranscriptFailure(
        call.id,
        systemic
          ? "the recording couldn't be downloaded — the phone provider refused the request"
          : "the recording couldn't be downloaded",
      );
      logger[systemic ? "error" : "warn"](
        { callId, status: upstream.status },
        systemic
          ? "ai: recording fetch refused by the provider — check the Plivo credentials cover this account"
          : "ai: recording fetch failed",
      );
    }
  }
  if (!transcript && !call.notes) return "no transcript or notes to analyse";

  // 2) LLM analysis. Prefer the English translation — more reliable input for
  // scoring/coaching than raw native script. Generous budget: thinking
  // models reason before answering.
  const userPrompt = analysisPrompt({
    direction: call.direction,
    durationSec: call.durationSec,
    repName: call.repName,
    guestName: call.guest?.fullName ?? null,
    stage: call.enquiry?.stage ?? null,
    transcript: transcriptEnglish ?? transcript,
    notes: call.notes,
  });

  const t0 = Date.now();
  let result: AnalysisResult;
  try {
    // Validate/clamp before writing to the call record (F36).
    result = parseLlm(analysisSchema, await chatJSON<unknown>(SYSTEM, userPrompt, { maxTokens: 2000 }));
  } catch (err) {
    await logAiDecision({
      kind: "call_analysis",
      callId: call.id,
      enquiryId: call.enquiryId ?? undefined,
      promptSystem: SYSTEM,
      promptUser: userPrompt,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
      triggeredBy,
      triggeredByName,
    });
    throw err;
  }

  await prisma.call.update({
    where: { id: call.id },
    data: {
      aiSummary: result.summary,
      aiScore: Math.max(0, Math.min(100, Math.round(result.score))),
      aiTags: (result.tags ?? []).slice(0, 8).map((t) => String(t).toLowerCase()),
      aiSuggestions: result.suggestions as object,
      aiAnalyzedAt: new Date(),
    },
  });
  await logAiDecision({
    kind: "call_analysis",
    callId: call.id,
    enquiryId: call.enquiryId ?? undefined,
    promptSystem: SYSTEM,
    promptUser: userPrompt,
    output: result,
    success: true,
    durationMs: Date.now() - t0,
    triggeredBy,
    triggeredByName,
  });
  logger.info({ callId, score: result.score }, "ai: call analysed");
  return null;
}

/** Batch step for the pipeline: analyse up to `limit` pending calls. */
export async function runCallAnalysis(limit = 5): Promise<number> {
  const pending = await prisma.call.findMany({
    where: pendingCallsWhere(),
    orderBy: { startedAt: "desc" },
    take: limit,
    select: { id: true, aiAnalyzedAt: true },
  });

  let done = 0;
  // Calls this tick removed from the queue without analysing them (nothing to
  // analyse). That is progress, not a jam — the queue is shorter afterwards.
  let retired = 0;
  for (const { id, aiAnalyzedAt } of pending) {
    try {
      const skipped = await analyzeCall(id, aiAnalyzedAt !== null);
      if (!skipped) done++;
      else if (!aiAnalyzedAt) {
        // Nothing usable — stamp it so the pipeline doesn't retry forever.
        await prisma.call.update({ where: { id }, data: { aiAnalyzedAt: new Date() } });
        retired++;
      }
    } catch (err) {
      logger.error({ err, callId: id }, "ai: call analysis failed");
    }
  }

  // A tick that selects work and completes none of it is how the queue jammed
  // before: the same calls were picked every five minutes and none could ever
  // succeed. The attempt cap now bounds that, and this says so out loud if it
  // ever starts again.
  if (pending.length && !done && !retired) {
    logger.warn(
      { selected: pending.length, callIds: pending.map((c) => c.id) },
      "ai: call analysis tick made no progress — every selected call was skipped and none retired",
    );
  }
  // The other shape of the same failure is a backlog that grows while each
  // tick does a little work. One indexed count makes it visible in the log
  // instead of only in the Calls tab weeks later.
  if (pending.length === limit) {
    const backlog = await prisma.call.count({ where: pendingCallsWhere() });
    if (backlog > limit) logger.info({ backlog, done }, "ai: calls still waiting for analysis");
  }
  return done;
}

/** Record why no transcript came out — the Calls tab shows this text. */
async function noteTranscriptFailure(callId: string, reason: string): Promise<void> {
  await prisma.call
    .update({ where: { id: callId }, data: { transcriptError: reason } })
    .catch(() => null);
}
