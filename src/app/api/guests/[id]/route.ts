import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { handle, ok, requireSession, requirePermission, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { ageFromDob, ageGroup } from "@/lib/utils";
import { updateGuestSchema } from "@/lib/validation";
import { deleteGuestRecord } from "@/lib/guest-delete";

export const dynamic = "force-dynamic";

// GET /api/guests/:id — demographic detail (+ whether a health profile exists)
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "leads.view") && !can(ctx.roles, "health.view")) {
      throw new ApiError("FORBIDDEN", "No access", 403);
    }
    const g = await prisma.guest.findFirst({
      where: { id: params.id, deletedAt: null },
      include: {
        healthProfile: { select: { id: true, updatedAt: true } },
        _count: { select: { enquiries: true } },
      },
    });
    if (!g) throw new ApiError("NOT_FOUND", "Guest not found", 404);

    const age = ageFromDob(g.dateOfBirth);
    return ok({
      id: g.id,
      fullName: g.fullName,
      phone: g.phone,
      email: g.email,
      city: g.city,
      gender: g.gender,
      dateOfBirth: g.dateOfBirth?.toISOString() ?? null,
      age,
      ageGroup: ageGroup(age),
      isReturning: g.isReturning,
      isBlocked: g.isBlocked,
      tags: g.tags,
      enquiryCount: g._count.enquiries,
      hasHealthProfile: Boolean(g.healthProfile),
      healthUpdatedAt: g.healthProfile?.updatedAt.toISOString() ?? null,
    });
  });
}

// PATCH /api/guests/:id — edit a guest directory record's core fields
// directly from the guest card. Same field set as guest creation, all
// optional (a partial update) — omitted fields are left unchanged.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    await requirePermission("leads.manage");
    const input = updateGuestSchema.parse(await req.json());

    const current = await prisma.guest.findFirst({
      where: { id: params.id, deletedAt: null },
      select: { id: true, phone: true, email: true },
    });
    if (!current) throw new ApiError("NOT_FOUND", "Guest not found", 404);

    const nextPhone = input.phone !== undefined ? input.phone.trim() || null : current.phone;
    const nextEmail = input.email !== undefined ? input.email.trim() || null : current.email;
    if (!nextPhone && !nextEmail) {
      throw new ApiError("VALIDATION_ERROR", "A guest needs at least a phone number or email.", 400);
    }

    let updated;
    try {
      updated = await prisma.guest.update({
        where: { id: params.id },
        data: {
          fullName: input.fullName?.trim() || undefined,
          phone: input.phone !== undefined ? nextPhone : undefined,
          email: input.email !== undefined ? nextEmail : undefined,
          city: input.city !== undefined ? (input.city.trim() || null) : undefined,
          gender: input.gender ?? undefined,
          dateOfBirth: input.dateOfBirth !== undefined
            ? (input.dateOfBirth ? new Date(input.dateOfBirth) : null)
            : undefined,
        },
        include: { _count: { select: { enquiries: true } }, healthProfile: { select: { id: true } } },
      });
    } catch (err) {
      // phone/email are unique — editing into a value another guest already
      // holds hits this instead of silently overwriting/merging records.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const field = (err.meta?.target as string[] | undefined)?.[0] ?? "phone or email";
        throw new ApiError("CONFLICT", `Another guest already has that ${field}.`, 409);
      }
      throw err;
    }

    return ok({
      id: updated.id,
      fullName: updated.fullName,
      phone: updated.phone,
      email: updated.email,
      city: updated.city,
      gender: updated.gender,
      ageGroup: ageGroup(ageFromDob(updated.dateOfBirth)),
      isReturning: updated.isReturning,
      isBlocked: updated.isBlocked,
      tags: updated.tags,
      enquiryCount: updated._count.enquiries,
      hasHealthProfile: Boolean(updated.healthProfile),
    });
  });
}

// DELETE /api/guests/:id?mode=soft|hard — admin-only.
//
// soft (default): the guest (and their enquiries/notes/tasks/messages/calls/
//   documents history) is kept, just excluded from guest search and the
//   leads pipeline going forward — the same DPDP-erasure pattern already
//   used for leads (see leads.delete). Fully reversible by clearing
//   deletedAt.
//
// hard: wipes EVERYTHING tied to this guest — every enquiry (with its
//   notes/tasks cascading), every WhatsApp/email conversation, every call,
//   every document (+ storage objects), the activity audit log, AI
//   decisions, and memberships — then removes the Guest row itself.
//   Irreversible. Unlike a lead ticket's own hard delete (which only
//   removes that one enquiry and leaves the guest's history intact for
//   their other enquiries), this removes the guest and ALL of it.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return handle(async () => {
    const ctx = await requirePermission("guests.delete");
    const mode = req.nextUrl.searchParams.get("mode") === "hard" ? "hard" : "soft";
    await deleteGuestRecord(params.id, mode, ctx.sub);
    return ok({ id: params.id, mode });
  });
}
