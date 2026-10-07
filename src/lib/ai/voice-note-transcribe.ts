/**
 * Speech-to-text for WhatsApp voice notes — the same pipeline call recordings
 * already use (lib/ai/call-analysis.ts): decode once per candidate language,
 * drop dead decodes, then reconcile/translate to English with the chat model.
 *
 * A voice note is not a call, so two things differ:
 *   • the audio comes from our own object storage, not Plivo;
 *   • the "is this real speech" floor is far lower — a genuine note is often
 *     one clause, which the call floor would throw away (VOICE_NOTE_TRANSCRIPT_FLOOR).
 *
 * The transcript lands on the Message row, which is what the conversation
 * thread, the lead's activity timeline and the Activity Log all read.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { getObjectBuffer } from "@/lib/storage";
import { isVoiceNoteMime, MAX_TRANSCRIPT_ATTEMPTS } from "@/lib/voice-note";
import { asrLanguages, voiceNoteMaxAgeDays, voiceNoteTranscriptionEnabled } from "./config";
import { transcribeAudio } from "./transcribe";
import { reconcileTranscript, type TranscriptAttempt } from "./transcript-translate";
import {
  collapseRepetitions,
  isUsableTranscript,
  VOICE_NOTE_TRANSCRIPT_FLOOR,
} from "./transcript-quality";

/** How many the background sweep takes per tick. Each one is a full decode. */
const BATCH = 5;

/**
 * How long a failed clip waits before the sweep tries it again. Without this,
 * a five-minute pipeline tick burns all three attempts inside ten minutes of
 * an ASR outage — which is exactly the case the retries exist for.
 */
const RETRY_AFTER_MS = 30 * 60_000;

/**
 * Message ids being decoded right now. The send/webhook kick and the pipeline
 * sweep run in the same process, and a decode takes tens of seconds, so
 * without this a tick landing mid-decode re-runs the whole thing — a second
 * ASR pass, a second LLM call, a second audit row, and a burnt attempt.
 */
const inFlight = new Set<string>();

const EXT_BY_MIME: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/webm": "webm",
};

/** Whisper picks its decoder from the filename, so the extension has to match
 *  what the bytes actually are. */
function audioFilename(messageId: string, mimeType: string): string {
  const base = mimeType.toLowerCase().split(";")[0].trim();
  return `voice-note-${messageId}.${EXT_BY_MIME[base] ?? "ogg"}`;
}

/**
 * Transcribe one voice note. Returns the reason it was skipped, or null when a
 * transcript was written. Throws only if the database itself is unreachable —
 * an ASR failure is a returned reason, not an exception, because every caller
 * is a background sweep or a fire-and-forget kick after a send.
 */
export async function transcribeVoiceNote(messageId: string): Promise<string | null> {
  if (!voiceNoteTranscriptionEnabled()) return "voice-note transcription is disabled";
  if (inFlight.has(messageId)) return "already being transcribed";

  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    include: { attachmentDocument: { select: { mimeType: true, storageKey: true } } },
  });
  if (!msg) return "message not found";
  if (!isVoiceNoteMime(msg.attachmentDocument?.mimeType)) return "not a voice note";
  if (msg.transcribedAt) return "already transcribed";
  // A redacted message must not gain a transcript — the thread hides its body,
  // and the activity log would otherwise print what it hid.
  if (msg.deletedAt) return "message was deleted";
  if (msg.transcriptAttempts >= MAX_TRANSCRIPT_ATTEMPTS) return "gave up after repeated failures";

  inFlight.add(messageId);
  try {
    return await run(msg);
  } finally {
    inFlight.delete(messageId);
  }
}

type PendingVoiceNote = {
  id: string;
  enquiryId: string | null;
  guestId: string | null;
  attachmentDocument: { mimeType: string; storageKey: string } | null;
};

async function run(msg: PendingVoiceNote): Promise<string | null> {
  // Counted before the work, not after: a decode that hangs or crashes the
  // process must still cost an attempt, or a poison clip is retried forever.
  // The message can be gone by now (deleting an enquiry cascades to its
  // messages), so every write here tolerates a vanished row.
  if (!(await patch(msg.id, { transcriptAttempts: { increment: 1 }, transcriptAttemptAt: new Date() }))) {
    return "message no longer exists";
  }

  const fail = async (reason: string) => {
    await patch(msg.id, { transcriptError: reason });
    return reason;
  };

  let audio: ArrayBuffer;
  try {
    const buf = await getObjectBuffer(msg.attachmentDocument!.storageKey);
    audio = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  } catch (err) {
    logger.warn({ messageId: msg.id, err }, "voice note: audio fetch failed");
    return fail("the audio file couldn't be read");
  }

  const filename = audioFilename(msg.id, msg.attachmentDocument!.mimeType);
  const attempts: TranscriptAttempt[] = [];
  for (const lang of asrLanguages()) {
    try {
      const text = await transcribeAudio(audio, filename, lang);
      if (isUsableTranscript(text, VOICE_NOTE_TRANSCRIPT_FLOOR)) {
        attempts.push({ language: lang ?? "auto", text });
      } else {
        logger.info(
          { messageId: msg.id, lang, chars: text.trim().length },
          "voice note: attempt returned no usable speech",
        );
      }
    } catch (err) {
      logger.warn({ messageId: msg.id, lang, err }, "voice note: transcription attempt failed");
    }
  }
  if (!attempts.length) return fail("no speech was recognised in the recording");

  let reconciled;
  try {
    reconciled = await reconcileTranscript(attempts, {
      enquiryId: msg.enquiryId ?? undefined,
      guestId: msg.guestId ?? undefined,
      floor: VOICE_NOTE_TRANSCRIPT_FLOOR,
    });
  } catch (err) {
    logger.warn({ messageId: msg.id, err }, "voice note: reconcile/translate failed");
    return fail("the transcript couldn't be translated");
  }
  if (!reconciled) return fail("no speech was recognised in the recording");

  await patch(msg.id, {
    transcript: collapseRepetitions(reconciled.nativeText),
    transcriptEnglish: collapseRepetitions(reconciled.englishText),
    transcriptLanguage: reconciled.language,
    transcribedAt: new Date(),
    transcriptError: null,
  });
  logger.info({ messageId: msg.id, language: reconciled.language }, "voice note transcribed");
  return null;
}

/** Update the message if it still exists. False when it has since been
 *  deleted — which cascades from deleting the enquiry — rather than throwing
 *  P2025 out of a background sweep. */
async function patch(id: string, data: Prisma.MessageUpdateInput): Promise<boolean> {
  const { count } = await prisma.message.updateMany({ where: { id }, data });
  return count > 0;
}

/**
 * Start transcribing right after a voice note is sent or received, without
 * making the caller wait for it (a decode takes seconds; the webhook and the
 * send route must answer immediately). Anything this misses — process
 * restart, ASR down — the sweep below picks up.
 */
export function queueVoiceNoteTranscription(messageId: string): void {
  if (!voiceNoteTranscriptionEnabled()) return;
  void transcribeVoiceNote(messageId).catch((err) =>
    logger.error({ messageId, err }, "voice note transcription failed"),
  );
}

/** Background sweep — the voice notes still waiting for a transcript, newest
 *  first. Returns how many were transcribed. */
export async function runVoiceNoteTranscription(limit = BATCH): Promise<number> {
  if (!voiceNoteTranscriptionEnabled()) return 0;

  const pending = await prisma.message.findMany({
    where: {
      channel: "whatsapp",
      transcribedAt: null,
      transcriptAttempts: { lt: MAX_TRANSCRIPT_ATTEMPTS },
      deletedAt: null,
      createdAt: { gte: new Date(Date.now() - voiceNoteMaxAgeDays() * 86_400_000) },
      attachmentDocument: { mimeType: { startsWith: "audio/" } },
      // Spaced out, so an ASR outage doesn't spend every attempt in the first
      // ten minutes of it.
      OR: [
        { transcriptAttemptAt: null },
        { transcriptAttemptAt: { lt: new Date(Date.now() - RETRY_AFTER_MS) } },
      ],
    },
    select: { id: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  let done = 0;
  for (const m of pending) {
    try {
      if ((await transcribeVoiceNote(m.id)) === null) done++;
    } catch (err) {
      logger.error({ messageId: m.id, err }, "voice note transcription failed");
    }
  }
  return done;
}
