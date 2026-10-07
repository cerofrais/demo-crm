/**
 * Which calls the background pass picks up, as pure functions so the rules
 * can be tested without a database.
 *
 * This exists because the rules got it wrong once, in a way that was silent:
 * the retry branch re-selected any call with a recording and no English
 * transcript — including `no_answer` calls, whose recording is ringing only
 * and which transcription deliberately refuses. Sorted newest-first with a
 * batch of five, the same five calls held every slot on every tick. Over six
 * hours that was 72 ticks, 144 re-decodes of two recordings, and
 * `callsAnalyzed: 0` every single time, while ten calls from three weeks
 * earlier had never been looked at at all.
 *
 * The invariants that stop it happening again:
 *   1. a call the pipeline refuses to transcribe is never re-queued for one;
 *   2. every attempt is counted, so failure is finite;
 *   3. retries are spaced, so an ASR outage doesn't spend the budget at once.
 */
import type { Prisma } from "@prisma/client";

/** Statuses worth analysing at all. */
export const ANALYSABLE_STATUSES = ["completed", "no_answer", "voicemail"] as const;

/**
 * Statuses whose recording can actually contain a conversation.
 *
 * `no_answer` is excluded deliberately: Plivo bridges the rep's leg first, so
 * the file holds the "connecting your customer now" announcement and then
 * ringing. Measured over 50 such recordings, 21 produced repetition loops
 * that were then scored as if they were real calls.
 */
export const TRANSCRIBABLE_STATUSES = ["completed", "voicemail"] as const;

export function isTranscribableStatus(status: string): boolean {
  return (TRANSCRIBABLE_STATUSES as readonly string[]).includes(status);
}

/** Attempts before a recording is left alone. */
export const MAX_TRANSCRIPT_ATTEMPTS = 3;

/** How long a failed recording waits before the next attempt. Long enough
 *  that a five-minute tick can't spend all three attempts in ten minutes. */
export const RETRY_AFTER_MS = 30 * 60_000;

export interface CallQueueState {
  status: string;
  aiAnalyzedAt: Date | null;
  recordingUrl: string | null;
  transcriptEnglish: string | null;
  transcriptAttempts: number;
  transcriptAttemptAt: Date | null;
}

/**
 * Whether this call may be transcribed now: it has audio that can hold
 * speech, no transcript yet, attempts left, and its cooldown has passed.
 */
export function canTranscribeNow(call: CallQueueState, now = new Date()): boolean {
  if (!call.recordingUrl) return false;
  if (!isTranscribableStatus(call.status)) return false;
  if (call.transcriptEnglish) return false;
  if (call.transcriptAttempts >= MAX_TRANSCRIPT_ATTEMPTS) return false;
  if (call.transcriptAttemptAt && now.getTime() - call.transcriptAttemptAt.getTime() < RETRY_AFTER_MS) {
    return false;
  }
  return true;
}

/**
 * The batch query's filter.
 *
 * Two ways in, and only two:
 *   • never analysed, and there is something to analyse (a recording or the
 *     rep's notes);
 *   • analysed already but still transcribable — the recording landed after
 *     the first pass (Plivo's callback trails the call by seconds to
 *     minutes), so the transcript never matched the audio. Bounded by the
 *     attempt cap and the cooldown, which is what the earlier version
 *     lacked.
 */
export function pendingCallsWhere(now = new Date()): Prisma.CallWhereInput {
  return {
    status: { in: [...ANALYSABLE_STATUSES] },
    OR: [
      {
        aiAnalyzedAt: null,
        OR: [{ recordingUrl: { not: null } }, { notes: { not: null } }],
      },
      {
        aiAnalyzedAt: { not: null },
        // Never no_answer: transcription skips it, so re-queueing it is a
        // guaranteed no-op that costs a slot.
        status: { in: [...TRANSCRIBABLE_STATUSES] },
        recordingUrl: { not: null },
        transcriptEnglish: null,
        transcriptAttempts: { lt: MAX_TRANSCRIPT_ATTEMPTS },
        OR: [
          { transcriptAttemptAt: null },
          { transcriptAttemptAt: { lt: new Date(now.getTime() - RETRY_AFTER_MS) } },
        ],
      },
    ],
  };
}

/** Why a call has no transcript, for the Calls tab. Null when it has one, or
 *  when the pipeline may still produce one. */
export function callTranscriptStatus(
  call: Pick<CallQueueState, "status" | "recordingUrl" | "transcriptEnglish" | "transcriptAttempts"> & {
    transcript?: string | null;
    transcriptError?: string | null;
  },
): string | null {
  if (call.transcriptEnglish || call.transcript) return null;
  if (!call.recordingUrl) return "No recording for this call";
  if (!isTranscribableStatus(call.status)) {
    return "Not transcribed — the call wasn't answered, so the recording is ringing only";
  }
  if (call.transcriptAttempts >= MAX_TRANSCRIPT_ATTEMPTS) {
    return call.transcriptError?.trim()
      ? `No transcript — ${call.transcriptError.trim()}`
      : "No transcript — the recording couldn't be transcribed";
  }
  return "Transcribing…";
}
