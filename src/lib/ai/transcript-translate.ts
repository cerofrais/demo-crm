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
import {
  collapseRepetitions,
  isPredominantlyLatin,
  isUsableTranscript,
  type TranscriptFloor,
} from "./transcript-quality";

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
You receive the SAME audio transcribed one or more times. When more than one attempt is present, each was decoded assuming a different target language, so words spoken in another language come out as inaccurate phonetic transliteration in that attempt.
Your job:
1. Determine which language is actually being spoken (or if it's a genuine mix, e.g. Telugu with English business terms) — use whichever attempt reads most coherently as your main evidence.
2. Produce one clean, accurate native-script transcript, correcting obvious phonetic-transliteration artifacts using context (e.g. a string that's clearly an English word rendered phonetically should be corrected or left in English within the native-script sentence, matching how a bilingual person would actually write it down).
3. Produce a natural, fluent English translation of the same content — this is what staff will read day to day, so prioritise clarity and accuracy over literal word-for-word translation.
If only one attempt was provided, do the same job using just that one.

CRITICAL — NEVER INVENT CONTENT. You are transcribing a real call that real staff will act on.
- Reproduce only what is actually present in the attempts. Do not add greetings, offers, package names, prices, or pleasantries that are not there.
- Do not "complete" a partial or truncated call, and do not smooth a fragmentary transcript into a plausible-sounding sales conversation.
- If the attempts are too garbled, too short, or too empty to recover real speech, return empty strings for nativeText and englishText. An empty transcript is correct and useful; an invented one is a serious error.
${DATA_FENCE_RULES}`;

/**
 * Runs the reconciliation/translation LLM call and logs it to the AI/ML
 * decision audit trail. Throws (and logs the failure) if the LLM call fails.
 */
export async function reconcileTranscript(
  attempts: TranscriptAttempt[],
  context: {
    callId?: string;
    enquiryId?: string;
    guestId?: string;
    /** How short an attempt may be and still count as speech — a voice note
     *  is a sentence, not a call. Defaults to the call floor. */
    floor?: TranscriptFloor;
  },
): Promise<ReconciledTranscript | null> {
  // Hard gate, independent of the prompt above. A failed decode comes back as
  // "" or a few stray syllables rather than an error, and asking the model to
  // write "a clean transcript of a wellness sales call" from that produced
  // fluent, entirely fabricated conversations that were stored on the call
  // record and scored as real. Prompt instructions alone are not a sufficient
  // defence here — if nothing usable came back, don't call the LLM at all.
  const usable = attempts.filter((a) => isUsableTranscript(a.text, context.floor));
  if (!usable.length) return null;

  // Fast path: a single attempt that is already Latin-script English needs
  // neither reconciliation (nothing to reconcile against) nor translation.
  // Sending it to the LLM anyway was actively harmful — a full call transcript
  // overruns the response budget and comes back as truncated JSON, losing the
  // tail of a transcript that was already correct.
  if (usable.length === 1 && isPredominantlyLatin(usable[0].text)) {
    const text = collapseRepetitions(usable[0].text);
    return { language: "en", nativeText: text, englishText: text };
  }

  const userPrompt = [
    "ASR ATTEMPTS (same audio, each decoded assuming a different target language):",
    // Each attempt is untrusted transcribed speech — fence it as DATA. Decoder
    // loops are folded down first so a repeated clause can't crowd the real
    // content out of the context window.
    ...usable.map(
      (a) => "\n" + fence("ATTEMPT", collapseRepetitions(a.text), { target_language: a.language }),
    ),
    "",
    `Return JSON: {"language": string, "nativeText": string, "englishText": string}`,
    `"language" must be one of the exact candidate ISO codes shown above (e.g. "te", "hi", "en"), or "mixed" — never a language name like "Telugu".`,
    `Reproduce only what the attempts actually contain. If they are too garbled or too sparse to recover real speech, return "" for nativeText and englishText.`,
  ].join("\n");

  // The reply carries the transcript twice (native + English), so the budget
  // has to scale with the input or long calls come back as truncated JSON.
  // Indic scripts tokenise far less efficiently than English, hence ~1 token
  // per character rather than the usual ~1 per 4, plus headroom for the JSON
  // envelope. Capped so a runaway transcript can't request an absurd budget.
  const longest = Math.max(...usable.map((a) => a.text.length));
  const maxTokens = Math.min(16_000, Math.max(2500, longest * 2 + 1000));

  const t0 = Date.now();
  let result: ReconciledTranscript;
  try {
    // Validate/cap the model output before it is persisted (F36).
    result = parseLlm(reconciledSchema, await chatJSON<unknown>(SYSTEM, userPrompt, { maxTokens }));
  } catch (err) {
    await logAiDecision({
      kind: "transcript_translation",
      callId: context.callId,
      enquiryId: context.enquiryId,
      guestId: context.guestId,
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
    guestId: context.guestId,
    promptSystem: SYSTEM,
    promptUser: userPrompt,
    output: result,
    success: true,
    durationMs: Date.now() - t0,
  });

  // The model may correctly decline (returning empty strings, as instructed) on
  // input it can't recover. Treat that the same as "no transcript" rather than
  // persisting a blank one over the call record.
  if (
    !isUsableTranscript(result.nativeText, context.floor) &&
    !isUsableTranscript(result.englishText, context.floor)
  ) {
    return null;
  }
  return result;
}
