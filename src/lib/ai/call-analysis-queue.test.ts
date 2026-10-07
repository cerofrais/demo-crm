import { describe, expect, it } from "vitest";
import {
  callTranscriptStatus,
  canTranscribeNow,
  MAX_TRANSCRIPT_ATTEMPTS,
  pendingCallsWhere,
  RETRY_AFTER_MS,
  type CallQueueState,
} from "./call-analysis-queue";

const call = (over: Partial<CallQueueState> = {}): CallQueueState => ({
  status: "completed",
  aiAnalyzedAt: new Date("2026-09-20T10:00:00Z"),
  recordingUrl: "https://plivo.example/rec.mp3",
  transcriptEnglish: null,
  transcriptAttempts: 0,
  transcriptAttemptAt: null,
  ...over,
});

describe("canTranscribeNow", () => {
  it("takes an answered call with a recording and no transcript", () => {
    expect(canTranscribeNow(call())).toBe(true);
    expect(canTranscribeNow(call({ status: "voicemail" }))).toBe(true);
  });

  it("never takes an unanswered call, whatever else is true of it", () => {
    // THE regression: a no_answer recording is ringing only, transcription
    // refuses it, and re-queueing it burns a slot on a guaranteed no-op.
    expect(canTranscribeNow(call({ status: "no_answer" }))).toBe(false);
    expect(canTranscribeNow(call({ status: "no_answer", transcriptAttempts: 0 }))).toBe(false);
  });

  it("stops after the attempt cap", () => {
    expect(canTranscribeNow(call({ transcriptAttempts: MAX_TRANSCRIPT_ATTEMPTS - 1 }))).toBe(true);
    expect(canTranscribeNow(call({ transcriptAttempts: MAX_TRANSCRIPT_ATTEMPTS }))).toBe(false);
    expect(canTranscribeNow(call({ transcriptAttempts: 99 }))).toBe(false);
  });

  it("waits out the cooldown between attempts", () => {
    const now = new Date("2026-09-21T12:00:00Z");
    const justTried = new Date(now.getTime() - RETRY_AFTER_MS + 60_000);
    const longAgo = new Date(now.getTime() - RETRY_AFTER_MS - 60_000);
    expect(canTranscribeNow(call({ transcriptAttempts: 1, transcriptAttemptAt: justTried }), now)).toBe(false);
    expect(canTranscribeNow(call({ transcriptAttempts: 1, transcriptAttemptAt: longAgo }), now)).toBe(true);
  });

  it("skips a call that already has a transcript, or has no audio", () => {
    expect(canTranscribeNow(call({ transcriptEnglish: "Hello, about the detox package…" }))).toBe(false);
    expect(canTranscribeNow(call({ recordingUrl: null }))).toBe(false);
  });
});

describe("pendingCallsWhere", () => {
  const where = pendingCallsWhere(new Date("2026-09-21T12:00:00Z"));
  const [fresh, retry] = (where.OR ?? []) as Record<string, unknown>[];

  it("offers exactly two ways in: never analysed, or retry", () => {
    expect(where.OR).toHaveLength(2);
    expect(fresh.aiAnalyzedAt).toBeNull();
    expect(retry.aiAnalyzedAt).toEqual({ not: null });
  });

  it("keeps unanswered calls out of the retry branch", () => {
    // Without this the 1,263 no_answer recordings sat in the queue
    // permanently, newest-first, and held every slot on every tick.
    expect(retry.status).toEqual({ in: ["completed", "voicemail"] });
  });

  it("bounds the retry branch by attempts and a cooldown", () => {
    expect(retry.transcriptAttempts).toEqual({ lt: MAX_TRANSCRIPT_ATTEMPTS });
    const or = retry.OR as Record<string, unknown>[];
    expect(or[0]).toEqual({ transcriptAttemptAt: null });
    expect(or[1]).toEqual({
      transcriptAttemptAt: { lt: new Date(Date.parse("2026-09-21T12:00:00Z") - RETRY_AFTER_MS) },
    });
  });

  it("still lets a never-analysed call in on notes alone", () => {
    expect(fresh.OR).toEqual([{ recordingUrl: { not: null } }, { notes: { not: null } }]);
  });
});

describe("callTranscriptStatus", () => {
  it("says nothing when there is a transcript", () => {
    expect(callTranscriptStatus(call({ transcriptEnglish: "…" }))).toBeNull();
  });

  it("explains the unanswered case rather than leaving the tab blank", () => {
    expect(callTranscriptStatus(call({ status: "no_answer" }))).toContain("wasn't answered");
  });

  it("reports the recorded reason once the attempts are spent", () => {
    expect(
      callTranscriptStatus({
        ...call({ transcriptAttempts: MAX_TRANSCRIPT_ATTEMPTS }),
        transcriptError: "no speech was recognised in the recording",
      }),
    ).toBe("No transcript — no speech was recognised in the recording");
  });

  it("is in-progress while attempts remain", () => {
    expect(callTranscriptStatus(call({ transcriptAttempts: 1 }))).toBe("Transcribing…");
  });

  it("distinguishes a call with no recording at all", () => {
    expect(callTranscriptStatus(call({ recordingUrl: null }))).toBe("No recording for this call");
  });
});
