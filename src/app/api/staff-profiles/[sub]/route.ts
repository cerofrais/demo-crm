/**
 * PUT /api/staff-profiles/[sub] — admin updates any staff profile
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin, type AppRole } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function PUT(req: NextRequest, { params }: { params: { sub: string } }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const roles = (session.roles ?? []) as AppRole[];
  if (!isAdmin(roles)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { phone, isOnline, displayName } = await req.json();
  if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) {
    return NextResponse.json({ error: "Phone must be E.164" }, { status: 400 });
  }

  const profile = await prisma.staffProfile.upsert({
    where: { keycloakId: params.sub },
    create: { keycloakId: params.sub, displayName: displayName ?? params.sub, phone: phone || null, isOnline: isOnline ?? true },
    update: {
      ...(displayName !== undefined && { displayName }),
      ...(phone !== undefined && { phone: phone || null }),
      ...(isOnline !== undefined && { isOnline }),
    },
  });

  return NextResponse.json(profile);
}
