import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

/** Liveness/readiness probe (spec §7.1): DB + Redis ping. */
export async function GET() {
  const checks = { db: false, redis: false };
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = true;
  } catch {
    /* db down */
  }
  try {
    await redis.ping();
    checks.redis = true;
  } catch {
    /* redis optional for liveness */
  }
  const healthy = checks.db;
  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", checks, ts: new Date().toISOString() },
    { status: healthy ? 200 : 503 },
  );
}
