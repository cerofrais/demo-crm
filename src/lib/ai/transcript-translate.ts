/**
 * Reconciles multiple single-language ASR attempts of the same call
 * recording into one accurate native-script transcript plus an English
 * translation. Needed because IndicConformer has no "auto" language mode and
 * no per-word language switching — each attempt only knows its own target
 * language, so it renders foreign words (English, or the other candidate
 * language) as inaccurate phonetic transliteration. The LLM sees all
 * attempts side by side and can usually tell which one is closer to the
 * truth, correct obvious transliteration artifacts, and translate cleanly.
 */
import { z } from "zod";
import { logAiDecision } from "./audit";
import { chatJSON } from "./provider";
import { DATA_FENCE_RULES, fence, llmString, parseLlm } from "./safety";

export interface TranscriptAttempt {
  language: string; // ISO code passed to the ASR backend, e.g. "te" | "hi"
  text: string;
}

export interface ReconciledTranscript {
  language: string; // best-guess actual spoken language, or "mixed"
  nativeText: string;
  englishText: string;
}

// F36 — validate/cap the model's JSON before it is written to the call record.
const reconciledSchema = z.object({
  language: llmString(24, "mixed"),
  nativeText: llmString(40_000),
  englishText: llmString(40_000),
});

const SYSTEM = `You reconcile speech-to-text attempts of the same sales call recording for Trē Wellness, an Ayurvedic wellness retreat in India.
You receive the SAME audio transcribed once per candidate language by a specialised Indian-language ASR model that has no English mode — each attempt renders the entire recording in one script, so English (or the other candidate language) comes out as inaccurate phonetic transliteration in that attempt.
Your job:
1. Determine which language is actually being spoken (or if it's a genuine mix, e.g. Telugu with English business terms) — use whichever attempt reads most coherently as your main evidence.
2. Produce one clean, accurate native-script transcript, correcting obvious phonetic-transliteration artifacts using context (e.g. a string that's clearly an English word rendered phonetically should be corrected or left in English within the native-script sentence, matching how a bilingual person would actually write it down).
3. Produce a natural, fluent English translation of the same content — this is what staff will read day to day, so prioritise clarity and accuracy over literal word-for-word translation.
If only one attempt was provided, do the same job using just that one.
${DATA_FENCE_RULES}`;

/**
 * Runs the reconciliation/translation LLM call and logs it to the AI/ML
 * decision audit trail. Throws (and logs the failure) if the LLM call fails.
 */
export async function reconcileTranscript(
  attempts: TranscriptAttempt[],
  context: { callId?: string; enquiryId?: string },
): Promise<ReconciledTranscript> {
  const userPrompt = [
    "ASR ATTEMPTS (same audio, each decoded assuming a different target language):",
    // Each attempt is untrusted transcribed speech — fence it as DATA.
    ...attempts.map((a) => "\n" + fence("ATTEMPT", a.text, { target_language: a.language })),
    "",
    `Return JSON: {"language": string, "nativeText": string, "englishText": string}`,
    `"language" must be one of the exact candidate ISO codes shown above (e.g. "te", "hi"), or "mixed" — never a language name like "Telugu".`,
  ].join("\n");

  const t0 = Date.now();
  let result: ReconciledTranscript;
  try {
    // Validate/cap the model output before it is persisted (F36).
    result = parseLlm(reconciledSchema, await chatJSON<unknown>(SYSTEM, userPrompt, { maxTokens: 2500 }));
  } catch (err) {
    await logAiDecision({
      kind: "transcript_translation",
      callId: context.callId,
      enquiryId: context.enquiryId,
      promptSystem: SYSTEM,
      promptUser: userPrompt,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    });
    throw err;
  }
  await logAiDecision({
    kind: "transcript_translation",
    callId: context.callId,
    enquiryId: context.enquiryId,
    promptSystem: SYSTEM,
    promptUser: userPrompt,
    output: result,
    success: true,
    durationMs: Date.now() - t0,
  });
  return result;
}
