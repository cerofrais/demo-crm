/**
 * Turning what a rep captured into a remark worth reading.
 *
 * A rep finishes a call and has a photo of a handwritten note, a voice memo,
 * or three lines of shorthand. Typing that up properly is the step that gets
 * skipped, so the remark ends up as "called, interested" — and six weeks later
 * nobody can tell what was agreed. This takes whatever was captured and writes
 * the remark the rep would have written with more time.
 *
 * It drafts; it does not save. The text lands back in the remark box for the
 * rep to read, edit and post, because the model misreads handwriting and
 * mishears numbers, and a wrong price or date saved unseen into a lead's
 * history is worse than no remark at all.
 *
 * Images go to gemma on the box (it reads them, despite its Ollama tag not
 * listing a vision capability); audio goes through the same Whisper the call
 * and voice-note pipelines use. Nothing leaves the server.
 */
import { logAiDecision } from "./audit";
import { chatJSON, MAX_IMAGE_BYTES, type ChatImage } from "./provider";
import { transcribeAudio, transcriptionEnabled } from "./transcribe";
import { DATA_FENCE_RULES, fence, llmString, parseLlm } from "./safety";
import { z } from "zod";

const SYSTEM = `You write the internal remark a sales rep of Trē Wellness, an Ayurvedic wellness retreat in India, would put on a lead in their CRM.

You are given what the rep captured: some typed shorthand, the text of a photo they took, and/or what they said in a voice note. Turn it into ONE clear remark that another rep can act on months later.

Rules:
- 1 to 4 sentences, plain English, past tense, no greeting and no sign-off.
- Keep every concrete detail exactly as given: names, phone numbers, dates, prices, room and programme names, number of people. Never round, convert or tidy a number.
- Write only what the captured material says. Never add a next step, a sentiment or a reason that was not stated.
- If something is unreadable or unclear, say so in the remark rather than guessing — for example "the date on the slip is not legible".
- No markdown, no bullet points, no headings.

Answer with JSON: {"remark": "<the remark>"}
${DATA_FENCE_RULES}`;

export interface RemarkDraftInput {
  /** What the rep typed, if anything. */
  text?: string;
  /** Images the rep attached — a photo of a note, a payment screenshot. */
  images?: ChatImage[];
  /** A voice note, transcribed here. */
  audio?: { bytes: ArrayBuffer; filename: string };
  /** Light context so the remark reads as being about this lead. */
  lead?: { name?: string | null; stage?: string | null };
  enquiryId?: string;
  triggeredBy?: string;
  triggeredByName?: string;
}

export interface RemarkDraft {
  remark: string;
  /** What the draft was built from, so the UI can say so. */
  usedText: boolean;
  usedImages: number;
  /** The raw transcript, shown to the rep: a misheard word is obvious there. */
  transcript: string | null;
}

export class NothingToDraftFrom extends Error {
  constructor() {
    super("Add a photo, a voice note or a few words first — there is nothing to write a remark from.");
  }
}

export class ImageTooLarge extends Error {
  constructor() {
    super(`Each image must be under ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB.`);
  }
}

const draftSchema = z.object({ remark: llmString(2000) });

/** How many images one remark can be built from. */
export const MAX_IMAGES = 3;

export async function draftRemark(input: RemarkDraftInput): Promise<RemarkDraft> {
  const text = input.text?.trim() ?? "";
  const images = (input.images ?? []).slice(0, MAX_IMAGES);
  for (const img of images) {
    // base64 is 4 chars per 3 bytes.
    if ((img.base64.length * 3) / 4 > MAX_IMAGE_BYTES) throw new ImageTooLarge();
  }

  let transcript: string | null = null;
  if (input.audio) {
    if (!transcriptionEnabled()) {
      throw new Error("Voice notes cannot be transcribed on this deployment (AI_TRANSCRIBE_BASE_URL).");
    }
    transcript = (await transcribeAudio(input.audio.bytes, input.audio.filename)).trim() || null;
  }

  if (!text && !images.length && !transcript) throw new NothingToDraftFrom();

  // Everything the rep captured is untrusted input — a photographed page can
  // carry text telling the model what to write — so each piece goes in fenced.
  const parts: string[] = [];
  if (input.lead?.name) {
    parts.push(`This is about the lead ${input.lead.name}${input.lead.stage ? ` (stage: ${input.lead.stage})` : ""}.`);
  }
  if (text) parts.push(fence("REP_NOTES", text));
  if (transcript) parts.push(fence("VOICE_NOTE", transcript));
  if (images.length) {
    parts.push(
      images.length === 1
        ? "The rep also attached one image, below. Read everything written in it."
        : `The rep also attached ${images.length} images, below. Read everything written in them.`,
    );
  }
  parts.push("Write the remark.");
  const user = parts.join("\n\n");

  const started = Date.now();
  try {
    const parsed = parseLlm(draftSchema, await chatJSON<unknown>(SYSTEM, user, { temperature: 0.1, maxTokens: 700, images }));
    const remark = parsed.remark.trim();
    if (!remark) throw new Error("The model returned an empty remark.");

    await logAiDecision({
      kind: "remark_draft",
      enquiryId: input.enquiryId,
      promptSystem: SYSTEM,
      promptUser: user,
      output: { remark, usedText: Boolean(text), usedImages: images.length, hadAudio: Boolean(transcript) },
      success: true,
      durationMs: Date.now() - started,
      triggeredBy: input.triggeredBy,
      triggeredByName: input.triggeredByName,
    });

    return { remark, usedText: Boolean(text), usedImages: images.length, transcript };
  } catch (err) {
    await logAiDecision({
      kind: "remark_draft",
      enquiryId: input.enquiryId,
      promptSystem: SYSTEM,
      promptUser: user,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
      triggeredBy: input.triggeredBy,
      triggeredByName: input.triggeredByName,
    });
    throw err;
  }
}
