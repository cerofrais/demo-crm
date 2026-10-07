/**
 * POST /api/enquiries/[id]/remark-draft — write up a remark from what the rep
 * captured: typed shorthand, a photo of a handwritten note, a voice memo.
 *
 * Multipart, and deliberately NOT a step in saving the remark. The files are
 * read into memory, sent to the model on this box and dropped; nothing is
 * stored, no Note is written, and the draft comes back to the rep's own text
 * box to read, fix and post — or discard. A model misreads handwriting and
 * mishears numbers, and a wrong price saved unseen into a lead's history is
 * worse than no remark at all.
 *
 * The same permission as writing the remark itself: anyone who could type it
 * can have it typed up, nobody else.
 */
import { NextRequest } from "next/server";
import { ApiError, handle, ok, requireSession } from "@/lib/api";
import { canMutateLeads, canWorkLeadStage } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { aiFeatureEnabled } from "@/lib/ai/config";
import { draftRemark, ImageTooLarge, NothingToDraftFrom, MAX_IMAGES } from "@/lib/ai/remark-draft";
import { isVoiceNoteMime } from "@/lib/voice-note";
import type { ChatImage } from "@/lib/ai/provider";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Whisper on CPU plus a vision pass on the shared GPU.
export const maxDuration = 300;

const DRAFTS_PER_MIN = Number(process.env.AI_REMARK_DRAFT_PER_MIN ?? 6);

const asNext = (r: Response) => new NextResponse(r.body, { status: r.status, headers: r.headers });

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!aiFeatureEnabled("remarkDraft")) {
      throw new ApiError("AI_DISABLED", "Writing remarks with AI is not enabled on this server.", 503);
    }

    const enquiry = await prisma.enquiry.findUnique({
      where: { id: params.id },
      select: { id: true, stage: true, guest: { select: { fullName: true } } },
    });
    if (!enquiry) throw new ApiError("NOT_FOUND", "Lead not found", 404);
    if (!(canMutateLeads(ctx.roles) && canWorkLeadStage(ctx.roles, enquiry.stage))) {
      throw new ApiError("FORBIDDEN", "Cannot add remarks to this lead", 403);
    }

    const limit = await rateLimit({ key: `remark-draft:${ctx.sub}`, limit: DRAFTS_PER_MIN, windowSec: 60 });
    if (!limit.allowed) return asNext(rateLimitResponse(limit));

    const form = await req.formData();
    const text = typeof form.get("text") === "string" ? (form.get("text") as string) : "";

    const images: ChatImage[] = [];
    let audio: { bytes: ArrayBuffer; filename: string } | undefined;
    for (const value of form.getAll("file")) {
      if (!(value instanceof File)) continue;
      const mime = value.type || "application/octet-stream";
      if (mime.startsWith("image/")) {
        if (images.length >= MAX_IMAGES) continue;
        images.push({ mimeType: mime, base64: Buffer.from(await value.arrayBuffer()).toString("base64") });
      } else if (mime.startsWith("audio/") || isVoiceNoteMime(mime)) {
        // One voice note: a second would just be transcribed over the first.
        audio ??= { bytes: await value.arrayBuffer(), filename: value.name || "remark.webm" };
      }
      // A PDF or a spreadsheet is left alone — the model is not being asked
      // to summarise documents here, and silently ignoring one is clearer
      // than a half-read draft.
    }

    try {
      const draft = await draftRemark({
        text,
        images,
        audio,
        lead: { name: enquiry.guest.fullName, stage: enquiry.stage },
        enquiryId: enquiry.id,
        triggeredBy: ctx.sub,
        triggeredByName: ctx.name,
      });
      return ok(draft);
    } catch (err) {
      if (err instanceof NothingToDraftFrom) throw new ApiError("VALIDATION_ERROR", err.message, 400);
      if (err instanceof ImageTooLarge) throw new ApiError("VALIDATION_ERROR", err.message, 413);
      throw err;
    }
  });
}
