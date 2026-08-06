/**
 * POST /api/guests/broadcast — start a bulk WhatsApp broadcast to a filtered
 * guest list (the client's currently-visible list, same as bulk email).
 * Runs in the background (see src/lib/broadcast.ts + instrumentation-node.ts)
 * — this just enqueues the job. Only one active broadcast at a time.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handle, ok, requireAllPermissions, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { startBroadcast } from "@/lib/broadcast";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  message: z.string().max(2000).default(""),
  guestIds: z.array(z.string().uuid()).min(1).max(5000),
  delaySec: z.number().int().min(1).max(300).default(3),
  numberId: z.string().uuid().optional(),
  imageDocumentId: z.string().uuid().optional(),
  /** Cloud API numbers only — send this approved template instead of `message`. */
  template: z
    .object({
      name: z.string().min(1),
      language: z.string().min(1),
      bodyParams: z.array(z.string()).default([]),
      /** Set only for a NAMED-parameter template ({{customer_name}}) — see broadcast.ts. */
      bodyParamNames: z.array(z.string()).optional(),
    })
    .optional(),
}).refine((v) => v.message.trim().length > 0 || v.template, {
  message: "Either a message or a template is required",
  path: ["message"],
});

export async function POST(req: NextRequest) {
  return handle(async () => {
    // WhatsApp broadcast is a Guests-page feature — messaging.send alone
    // isn't enough (Sales holds it for per-lead chat but has no guests.view
    // and shouldn't be able to reach this via a direct API call).
    const ctx = await requireAllPermissions(["messaging.send", "guests.view"]);
    const input = postSchema.parse(await req.json());

    // Restrict to guests that actually have a phone — anything else would
    // just be recorded as an immediate per-recipient failure by the worker.
    const withPhone = await prisma.guest.findMany({
      where: { id: { in: input.guestIds }, deletedAt: null, phone: { not: null } },
      select: { id: true },
    });
    if (withPhone.length === 0) {
      throw new ApiError("VALIDATION_ERROR", "None of the selected guests have a phone number on file", 400);
    }

    try {
      const job = await startBroadcast({
        message: input.message,
        guestIds: withPhone.map((g) => g.id),
        delaySec: input.delaySec,
        numberId: input.numberId,
        imageDocumentId: input.imageDocumentId,
        createdBySub: ctx.sub,
        template: input.template,
      });
      return ok({ id: job.id, status: job.status, totalCount: job.totalCount });
    } catch (err) {
      throw new ApiError("CONFLICT", err instanceof Error ? err.message : "Couldn't start broadcast", 409);
    }
  });
}
