/**
 * Guards against the two ways ASR output silently becomes worthless:
 *
 *  1. EMPTY / NEAR-EMPTY output. Whatever the backend, a failed decode tends to
 *     come back as "" or a couple of stray syllables rather than an error. That
 *     used to flow straight into the reconciliation LLM, which — being asked to
 *     "produce a clean transcript" of a wellness sales call with no actual
 *     content to work from — obligingly invented one. Fabricated transcripts
 *     were then stored on the call and scored as if real. `isUsableTranscript`
 *     is the gate that stops that at the source.
 *
 *  2. REPETITION LOOPS. Whisper-family decoders condition on their own previous
 *     output, so on narrowband (8 kHz telephony) audio they can lock into a
 *     cycle and emit the same clause tens of times. The content is real, but the
 *     repeats crowd out the rest of the call and skew analysis.
 *     `collapseRepetitions` folds consecutive duplicates back down to one.
 */

/**
 * Minimum characters before a decode counts as a real transcript. Chosen from
 * observed failure output: dead decodes land at 0-8 chars ("", a stray word),
 * while the shortest genuine call transcripts run to hundreds. 25 sits well
 * clear of the noise floor without discarding a terse but real exchange.
 */
const MIN_TRANSCRIPT_CHARS = 25;

/** Minimum distinct word count — catches a single token repeated into length. */
const MIN_DISTINCT_WORDS = 5;

/**
 * Whether an ASR attempt carries enough signal to be worth keeping. Rejects
 * empty/whitespace output, output below the length floor, and output that is
 * long only because one token repeats (e.g. "కోన్న్ను" ×200 from a degenerate
 * decode). Callers must treat `false` as "no transcript", never as "transcribe
 * it anyway with whatever this is".
 */
export interface TranscriptFloor {
  minChars: number;
  minDistinctWords: number;
}

/** Phone calls: minutes of speech, so anything short is a failed decode. */
export const CALL_TRANSCRIPT_FLOOR: TranscriptFloor = {
  minChars: MIN_TRANSCRIPT_CHARS,
  minDistinctWords: MIN_DISTINCT_WORDS,
};

/**
 * WhatsApp voice notes: a real one is often a single clause ("haan, bhej
 * dijiye", "yes please send"), which the call floor would throw away as a
 * failed decode. Low enough to keep those, high enough that a dead decode —
 * empty, or one stray syllable — still doesn't reach the LLM.
 */
export const VOICE_NOTE_TRANSCRIPT_FLOOR: TranscriptFloor = {
  minChars: 8,
  minDistinctWords: 2,
};

export function isUsableTranscript(
  text: string | null | undefined,
  floor: TranscriptFloor = CALL_TRANSCRIPT_FLOOR,
): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < floor.minChars) return false;
  if (isAsrFillerOnly(trimmed)) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  const distinct = new Set(words.map((w) => w.toLowerCase()));
  return distinct.size >= floor.minDistinctWords;
}

/**
 * Whisper's stock hallucinations on silence.
 *
 * Trained on captioned video, it fills near-silent audio with the phrases that
 * end one — "Thanks for watching!", a subtitle credit, "Please subscribe".
 * These are long enough to clear the length floors, so without this they are
 * stored as if the guest said them: a 2-second silent voice note in the
 * activity log reading "Thanks for watching!" is worse than no transcript.
 *
 * Only an ENTIRE transcript that is nothing but filler is rejected — a real
 * note that happens to END with "thank you very much" keeps everything.
 */
const ASR_FILLER = [
  "thanks for watching",
  "thanks for watching everyone",
  "thank you for watching",
  "thank you",
  "thank you very much",
  "thanks",
  "please subscribe",
  "subscribe to my channel",
  "like and subscribe",
  "see you next time",
  "see you in the next video",
  "bye",
  "bye bye",
  "you",
  "okay",
  "hmm",
  "subtitles by the amara.org community",
  "transcription by castingwords",
];

export function isAsrFillerOnly(text: string): boolean {
  const whole = bareWords(text);
  if (!whole) return false;
  if (FILLER_PHRASES.has(whole)) return true;
  // A filler run ("Thank you. Thank you. Thank you.") is still only filler.
  const sentences = text.split(/[.!?]+/).map(bareWords).filter(Boolean);
  return sentences.length > 1 && sentences.every((s) => FILLER_PHRASES.has(s));
}

/** Letters, digits and single spaces — punctuation and case carry no signal
 *  here, and "Amara.org" must not split a phrase into two sentences. */
function bareWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const FILLER_PHRASES = new Set(ASR_FILLER.map(bareWords));

/**
 * Whether a transcript is essentially already in Latin script — i.e. the ASR
 * returned English (or romanised speech) rather than an Indic script.
 *
 * Used to skip the reconcile/translate LLM round-trip entirely: when Whisper
 * has already produced clean English there is nothing to reconcile or
 * translate, and pushing 7k characters through an 8B model only risks it
 * truncating or paraphrasing a transcript that was already correct.
 *
 * Digits, punctuation and whitespace are ignored — only cased letters count,
 * so "GST 18%" doesn't skew the ratio.
 */
export function isPredominantlyLatin(text: string, threshold = 0.9): boolean {
  const letters = text.match(/\p{L}/gu);
  if (!letters?.length) return false;
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  return latin / letters.length >= threshold;
}

/**
 * Collapse runs of the same sentence/clause down to at most `maxRun` in a row.
 *
 * Only *consecutive* repeats are collapsed: a phrase genuinely said again later
 * in the call ("okay", a repeated price) is normal speech and is preserved,
 * whereas a decoder loop always emits its cycle back to back. Comparison is
 * case/punctuation-insensitive so near-identical repeats still fold together.
 *
 * `maxRun` defaults to 2 rather than 1 because people really do say things
 * twice ("Hello. Hello.", "Yes, yes."); keeping a pair preserves that while
 * still cutting the 10x-57x runs observed on production calls.
 */
export function collapseRepetitions(text: string, maxRun = 2): string {
  // Split into sentence-ish units, keeping the trailing punctuation on each.
  const parts = text.match(/[^.!?]+[.!?]*\s*/g);
  if (!parts) return text;

  const out: string[] = [];
  let prevKey = "";
  let run = 0;

  for (const part of parts) {
    const key = part.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ");
    if (!key) {
      out.push(part);
      continue;
    }
    if (key === prevKey) {
      run++;
      if (run >= maxRun) continue; // drop this repeat
    } else {
      prevKey = key;
      run = 0;
    }
    out.push(part);
  }
  return out.join("").trim();
}
