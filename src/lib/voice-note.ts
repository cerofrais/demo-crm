/**
 * What counts as a WhatsApp voice note, and how its transcript is worded
 * wherever it surfaces (activity log, lead timeline, conversation thread).
 *
 * Pure — no Prisma, no env — so both server routes and client components can
 * import it and agree on the same answer.
 */

/**
 * A voice note is any audio attachment on a WhatsApp message. WhatsApp itself
 * distinguishes a recorded voice note from an attached audio file (PTT flag),
 * but neither Baileys nor the Cloud API hands that over reliably — and both
 * are the same thing for our purposes: speech on the thread that nobody has
 * read yet. Video is deliberately excluded; the ASR endpoint takes audio.
 */
export function isVoiceNoteMime(mimeType: string | null | undefined): boolean {
  return !!mimeType && mimeType.toLowerCase().startsWith("audio/");
}

export interface VoiceNoteLike {
  attachmentDocument?: { mimeType: string } | null;
  channel?: string;
}

/** Whether this message is a WhatsApp voice note. */
export function isVoiceNote(m: VoiceNoteLike): boolean {
  if (m.channel && m.channel !== "whatsapp") return false;
  return isVoiceNoteMime(m.attachmentDocument?.mimeType);
}

/** How long a transcript may run before the log shows an ellipsis. Full text
 *  stays on the message; the log is a scan surface, not a reading one. */
export const TRANSCRIPT_EXCERPT_CHARS = 280;

export function transcriptExcerpt(
  text: string | null | undefined,
  max = TRANSCRIPT_EXCERPT_CHARS,
): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  // Collapse the newlines ASR sprinkles through a long clip — the log renders
  // this in a single paragraph.
  const flat = trimmed.replace(/\s*\n+\s*/g, " ");
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/** The text of a transcript, preferring the English translation.
 *
 *  `||`, not `??`: the reconciliation step is kept whenever EITHER the native
 *  transcript or the translation is usable, and the unusable one is stored as
 *  "" rather than null — so `??` would pick the empty translation and hide a
 *  perfectly good native transcript. */
export function transcriptText(m: {
  transcript?: string | null;
  transcriptEnglish?: string | null;
}): string | null {
  return m.transcriptEnglish?.trim() || m.transcript?.trim() || null;
}

/** Attempts before a clip is left alone. Three covers a restarting ASR box
 *  without re-decoding a silent clip forever. */
export const MAX_TRANSCRIPT_ATTEMPTS = 3;

/** Voice notes older than this are never picked up by the background sweep,
 *  so one that arrived while transcription was off is never transcribed. */
export const TRANSCRIBE_MAX_AGE_DAYS = 30;

/**
 * The one line a voice note gets while it has no transcript.
 *
 * `enabled` is whether this server transcribes at all: with no ASR endpoint
 * configured, a voice note is just a voice note, and promising a transcript
 * that will never arrive is worse than saying nothing. Null means "show
 * nothing" — the mic icon alone still marks the row.
 */
export function transcriptStatusText(
  m: {
    transcript?: string | null;
    transcriptEnglish?: string | null;
    transcriptError?: string | null;
    transcriptAttempts?: number | null;
    /** The message's own timestamp, for the too-old-to-ever-run case. */
    createdAt?: string | Date | null;
  },
  opts: { enabled?: boolean } = {},
): string | null {
  if (transcriptText(m)) return null;
  if (opts.enabled === false) return null;

  const attempts = m.transcriptAttempts ?? 0;
  // Nothing will pick this up again: either it has used up its attempts, or
  // it is past the window the background sweep looks back over.
  const stale = !!m.createdAt && isBeyondSweep(m.createdAt);
  if (attempts >= MAX_TRANSCRIPT_ATTEMPTS || stale) {
    if (m.transcriptError?.trim()) return `No transcript — ${m.transcriptError.trim()}`;
    return attempts === 0
      ? "No transcript — this voice note arrived before transcription was switched on"
      : "No transcript — the recording couldn't be transcribed";
  }
  return "Transcribing…";
}

function isBeyondSweep(createdAt: string | Date): boolean {
  const t = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t > TRANSCRIBE_MAX_AGE_DAYS * 86_400_000;
}
