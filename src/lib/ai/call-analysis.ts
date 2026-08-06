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
import { logAiDecision } from "./audit";
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
  if (!transcriptEnglish && call.recordingUrl && transcriptionEnabled()) {
    const upstream = await fetchRecording(call.recordingUrl);
    if (upstream.ok) {
      const audio = await upstream.arrayBuffer();
      const attempts: TranscriptAttempt[] = [];
      for (const lang of asrLanguages()) {
        try {
          const text = await transcribeAudio(audio, `call-${call.id}.mp3`, lang);
          attempts.push({ language: lang, text });
        } catch (err) {
          logger.warn({ callId, lang, err }, "ai: transcription attempt failed");
        }
      }
      if (attempts.length) {
        const reconciled = await reconcileTranscript(attempts, {
          callId: call.id,
          enquiryId: call.enquiryId ?? undefined,
        });
        transcript = reconciled.nativeText;
        transcriptEnglish = reconciled.englishText;
        await prisma.call.update({
          where: { id: call.id },
          data: { transcript, transcriptEnglish, transcriptLanguage: reconciled.language },
        });
      } else {
        logger.warn({ callId }, "ai: all transcription attempts failed");
      }
    } else {
      logger.warn({ callId, status: upstream.status }, "ai: recording fetch failed");
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
    where: {
      status: { in: ["completed", "no_answer", "voicemail"] },
      OR: [
        {
          aiAnalyzedAt: null,
          OR: [{ recordingUrl: { not: null } }, { notes: { not: null } }],
        },
        // Backfill: a call got analysed from notes only (Plivo's recording
        // callback hadn't landed yet — it's async and can trail the call
        // ending by anywhere from seconds to a couple minutes) — the
        // aiAnalyzedAt gate above then hid it from every later tick forever,
        // so the recording plays fine but the transcript never matches it.
        // Re-run now that a recording exists but no transcript came of it.
        {
          aiAnalyzedAt: { not: null },
          recordingUrl: { not: null },
          transcriptEnglish: null,
        },
      ],
    },
    orderBy: { startedAt: "desc" },
    take: limit,
    select: { id: true, aiAnalyzedAt: true },
  });

  let done = 0;
  for (const { id, aiAnalyzedAt } of pending) {
    try {
      const skipped = await analyzeCall(id, aiAnalyzedAt !== null);
      if (!skipped) done++;
      else if (!aiAnalyzedAt) {
        // Nothing usable — stamp it so the pipeline doesn't retry forever.
        await prisma.call.update({ where: { id }, data: { aiAnalyzedAt: new Date() } });
      }
    } catch (err) {
      logger.error({ err, callId: id }, "ai: call analysis failed");
    }
  }
  return done;
}
