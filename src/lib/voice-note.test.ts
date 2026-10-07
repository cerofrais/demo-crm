import { describe, expect, it } from "vitest";
import {
  isVoiceNote,
  isVoiceNoteMime,
  MAX_TRANSCRIPT_ATTEMPTS,
  TRANSCRIBE_MAX_AGE_DAYS,
  transcriptExcerpt,
  transcriptStatusText,
  transcriptText,
  TRANSCRIPT_EXCERPT_CHARS,
} from "./voice-note";
import { formatActionLabel } from "./activity-log";
import {
  isAsrFillerOnly,
  isUsableTranscript,
  CALL_TRANSCRIPT_FLOOR,
  VOICE_NOTE_TRANSCRIPT_FLOOR,
} from "./ai/transcript-quality";

describe("isVoiceNoteMime", () => {
  it("accepts every audio type WhatsApp and the in-browser recorder produce", () => {
    for (const mime of ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/webm"]) {
      expect(isVoiceNoteMime(mime)).toBe(true);
    }
    // Codec parameters ride along on the recorder's own mimeType.
    expect(isVoiceNoteMime("audio/webm;codecs=opus")).toBe(true);
    expect(isVoiceNoteMime("AUDIO/OGG")).toBe(true);
  });

  it("rejects anything that isn't audio", () => {
    for (const mime of ["video/mp4", "image/jpeg", "application/pdf", "", null, undefined]) {
      expect(isVoiceNoteMime(mime)).toBe(false);
    }
  });
});

describe("isVoiceNote", () => {
  it("is a WhatsApp message with an audio attachment", () => {
    expect(isVoiceNote({ channel: "whatsapp", attachmentDocument: { mimeType: "audio/ogg" } })).toBe(true);
  });

  it("is not an email attachment — that audio is a file, and no ASR runs on it", () => {
    expect(isVoiceNote({ channel: "email", attachmentDocument: { mimeType: "audio/mpeg" } })).toBe(false);
  });

  it("is not a message without an attachment", () => {
    expect(isVoiceNote({ channel: "whatsapp", attachmentDocument: null })).toBe(false);
    expect(isVoiceNote({ channel: "whatsapp" })).toBe(false);
  });
});

describe("transcriptExcerpt", () => {
  it("returns null for nothing to show", () => {
    expect(transcriptExcerpt(null)).toBeNull();
    expect(transcriptExcerpt("   ")).toBeNull();
  });

  it("flattens the newlines ASR sprinkles through a long clip", () => {
    expect(transcriptExcerpt("Yes please\n\nsend the details")).toBe("Yes please send the details");
  });

  it("trims to an ellipsis past the limit, keeping short ones whole", () => {
    const long = "a b ".repeat(200);
    const out = transcriptExcerpt(long)!;
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(TRANSCRIPT_EXCERPT_CHARS + 1);
    expect(transcriptExcerpt("Short one")).toBe("Short one");
  });
});

describe("transcriptStatusText", () => {
  it("says nothing once there is a transcript", () => {
    expect(transcriptStatusText({ transcriptEnglish: "Yes, send it" })).toBeNull();
    expect(transcriptStatusText({ transcript: "हाँ भेज दीजिए" })).toBeNull();
  });

  it("reads as in-progress while attempts remain", () => {
    expect(transcriptStatusText({ transcriptAttempts: 0 })).toBe("Transcribing…");
    expect(transcriptStatusText({ transcriptAttempts: MAX_TRANSCRIPT_ATTEMPTS - 1 })).toBe(
      "Transcribing…",
    );
  });

  it("says nothing at all on a server with no speech-to-text endpoint", () => {
    // Otherwise every voice note on a stock install promises a transcript that
    // is never coming.
    expect(transcriptStatusText({ transcriptAttempts: 0 }, { enabled: false })).toBeNull();
  });

  it("reports the failure on a note too old to be retried, rather than spinning", () => {
    const old = new Date(Date.now() - (TRANSCRIBE_MAX_AGE_DAYS + 1) * 86_400_000);
    expect(
      transcriptStatusText({
        transcriptAttempts: 1,
        transcriptError: "no speech was recognised in the recording",
        createdAt: old,
      }),
    ).toBe("No transcript — no speech was recognised in the recording");
  });

  it("stops waiting on a note older than the sweep's window", () => {
    const old = new Date(Date.now() - (TRANSCRIBE_MAX_AGE_DAYS + 1) * 86_400_000);
    expect(transcriptStatusText({ transcriptAttempts: 0, createdAt: old })).toContain(
      "No transcript",
    );
    const recent = new Date(Date.now() - 86_400_000);
    expect(transcriptStatusText({ transcriptAttempts: 0, createdAt: recent })).toBe("Transcribing…");
  });

  it("stops claiming to be working once the pipeline has given up, and says why", () => {
    expect(
      transcriptStatusText({
        transcriptAttempts: MAX_TRANSCRIPT_ATTEMPTS,
        transcriptError: "no speech was recognised in the recording",
      }),
    ).toBe("No transcript — no speech was recognised in the recording");
    // A clip that failed without a recorded reason still stops spinning.
    expect(transcriptStatusText({ transcriptAttempts: MAX_TRANSCRIPT_ATTEMPTS })).toContain(
      "No transcript",
    );
  });
});

describe("transcriptText", () => {
  it("prefers the English translation", () => {
    expect(transcriptText({ transcript: "हाँ भेज दीजिए", transcriptEnglish: "Yes, send it" })).toBe(
      "Yes, send it",
    );
  });

  it("falls back to the native transcript when the translation came back empty", () => {
    // reconcileTranscript keeps a result when EITHER side is usable, and the
    // unusable side is stored as "" — `??` would hide a good transcript here.
    expect(transcriptText({ transcript: "हाँ भेज दीजिए", transcriptEnglish: "" })).toBe(
      "हाँ भेज दीजिए",
    );
  });

  it("is null when there is nothing at all", () => {
    expect(transcriptText({ transcript: "", transcriptEnglish: null })).toBeNull();
  });
});

describe("voice note activity labels", () => {
  it("calls a voice note what it is, in both directions", () => {
    expect(formatActionLabel("message_sent", { channel: "whatsapp", voiceNote: true })).toBe(
      "Voice note sent",
    );
    expect(formatActionLabel("message_received", { channel: "whatsapp", voiceNote: true })).toBe(
      "Voice note received",
    );
  });

  it("leaves ordinary WhatsApp messages alone", () => {
    expect(formatActionLabel("message_sent", { channel: "whatsapp" })).toBe("WhatsApp message sent");
  });
});

describe("voice note transcript floor", () => {
  it("keeps a one-clause voice note that the call floor would throw away", () => {
    const short = "haan bhej dijiye";
    expect(isUsableTranscript(short, CALL_TRANSCRIPT_FLOOR)).toBe(false);
    expect(isUsableTranscript(short, VOICE_NOTE_TRANSCRIPT_FLOOR)).toBe(true);
  });

  it("still rejects a dead decode, which is what reaches the LLM otherwise", () => {
    for (const dud of ["", "   ", "ok", "हाँ"]) {
      expect(isUsableTranscript(dud, VOICE_NOTE_TRANSCRIPT_FLOOR)).toBe(false);
    }
  });

  it("defaults to the call floor, so existing callers are unchanged", () => {
    expect(isUsableTranscript("haan bhej dijiye")).toBe(false);
  });
});

describe("ASR filler", () => {
  it("rejects Whisper's stock hallucinations on silence", () => {
    // Both of these came back from real 5-10 KB clips on the production
    // backfill, from audio with no speech in it.
    for (const filler of [
      "Thanks for watching!",
      "Thank you very much.",
      "Thank you. Thank you. Thank you.",
      "Please subscribe",
      "Subtitles by the Amara.org community",
    ]) {
      expect(isAsrFillerOnly(filler)).toBe(true);
      expect(isUsableTranscript(filler, VOICE_NOTE_TRANSCRIPT_FLOOR)).toBe(false);
    }
  });

  it("keeps a real note that merely ends with a pleasantry", () => {
    const real = "Yes doctor, please send me the package details. Thank you very much.";
    expect(isAsrFillerOnly(real)).toBe(false);
    expect(isUsableTranscript(real, VOICE_NOTE_TRANSCRIPT_FLOOR)).toBe(true);
  });

  it("leaves non-English speech alone", () => {
    expect(isAsrFillerOnly("हाँ भेज दीजिए")).toBe(false);
  });
});
