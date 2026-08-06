/**
 * GET  /api/staff-profiles/me — own profile (phone, online status)
 * PUT  /api/staff-profiles/me — update own phone number
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function extractSub(session: Awaited<ReturnType<typeof auth>>): string {
  return (session?.user as { sub?: string })?.sub ?? "";
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const keycloakId = extractSub(session);
  const profile = await prisma.staffProfile.findUnique({ where: { keycloakId } });
  return NextResponse.json(profile ?? { keycloakId, displayName: session.user.name ?? "", phone: null, isOnline: true });
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const keycloakId = extractSub(session);

  const { phone, isOnline } = await req.json();
  // Validate E.164 if provided
  if (phone !== null && phone !== undefined && phone !== "") {
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
      return NextResponse.json({ error: "Phone must be in E.164 format, e.g. +919876543210" }, { status: 400 });
    }
  }

  const profile = await prisma.staffProfile.upsert({
    where: { keycloakId },
    create: {
      keycloakId,
      displayName: session.user.name ?? "",
      phone: phone || null,
      isOnline: isOnline ?? true,
    },
    update: {
      displayName: session.user.name ?? "",
      ...(phone !== undefined && { phone: phone || null }),
      ...(isOnline !== undefined && { isOnline }),
    },
  });

  return NextResponse.json(profile);
}
