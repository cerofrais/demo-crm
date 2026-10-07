/**
 * GET /api/calls/[id]/recording
 * Proxy the Plivo recording to the browser — Plivo URLs require Basic auth
 * which we can't put in a client-side <audio src> directly.
 */
import { NextRequest } from "next/server";
import { requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { fetchRecording } from "@/lib/plivo";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  // F13: use requireSession() (session-revocation aware) instead of raw auth().
  // This route streams audio, so map auth errors to plain Responses by hand.
  let ctx;
  try {
    ctx = await requireSession();
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    const message = err instanceof ApiError ? err.message : "Error";
    return new Response(message, { status });
  }

  // F13: recordings are sensitive — only the rep who handled the call or a user
  // allowed to see all staff's calls (reports.allStaff) may stream them.
  const call = await prisma.call.findUnique({
    where: { id: params.id },
    select: { recordingUrl: true, repKeycloakId: true },
  });
  if (!call?.recordingUrl) return new Response("No recording", { status: 404 });

  // Listening is its own permission now: a role can have the Calls screen
    // without the audio on it, and a rep can always play back a call they
    // were on, whatever else they hold.
    const allowed = can(ctx.roles, "calls.recording") || call.repKeycloakId === ctx.sub;
  if (!allowed) return new Response("Forbidden", { status: 403 });

  const upstream = await fetchRecording(call.recordingUrl);
  if (!upstream.ok) return new Response("Recording unavailable", { status: 502 });

  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("Content-Type") ?? "audio/mpeg");
  const cl = upstream.headers.get("Content-Length");
  if (cl) headers.set("Content-Length", cl);
  headers.set("Cache-Control", "private, max-age=3600");

  return new Response(upstream.body, { status: 200, headers });
}
