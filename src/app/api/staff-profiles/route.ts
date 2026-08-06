/**
 * GET /api/staff-profiles — all profiles (admin/manager only)
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { can, type AppRole } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const roles = (session.roles ?? []) as AppRole[];
  if (!can(roles, "reports.allStaff")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const profiles = await prisma.staffProfile.findMany({ orderBy: { displayName: "asc" } });
  return NextResponse.json(profiles);
}
