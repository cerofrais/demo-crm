/**
 * GET /api/reports/cresent/audio?week=… | from=…&to=… [&tags=a,b]
 *
 * Every call recording the Cresent CSV for the same range points at, as one
 * zip laid out campaign / lead / file — with that CSV at the root, so each
 * path in its Call Recording columns resolves to a file beside it. The paths
 * come from the same report build as the CSV, so the two can't drift.
 *
 * Streamed: the zip is written while recordings are fetched from Plivo one
 * at a time, so the download starts at once and a big week never sits in
 * memory. A recording that can't be fetched (the pre-20 Aug Plivo account
 * answers 401) is listed in _missing-recordings.txt instead of failing the
 * whole download.
 */
import { NextRequest, NextResponse } from "next/server";
import { PassThrough, Readable } from "node:stream";
import archiver, { type Archiver } from "archiver";
import { handle, requireSession, ApiError } from "@/lib/api";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { fetchRecording } from "@/lib/plivo";
import { buildCresentReport, cresentCsv, getCresentSettings } from "@/lib/cresent-report";
import { reportRecordings } from "@/lib/cresent-report-shape";
import { parseRangeParams } from "@/lib/cresent-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Self-hosted, so this is advisory; a week of recordings is minutes of fetching.
export const maxDuration = 900;

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireSession();
    if (!can(ctx.roles, "reports.allStaff")) throw new ApiError("FORBIDDEN", "Admin/Manager only", 403);

    const sp = req.nextUrl.searchParams;
    const range = parseRangeParams({ week: sp.get("week"), from: sp.get("from"), to: sp.get("to") });
    if ("error" in range) throw new ApiError("VALIDATION_ERROR", range.error, 400);
    const tags = sp.has("tags")
      ? (sp.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 30)
      : (await getCresentSettings()).tags;

    const report = await buildCresentReport(range, tags);
    const wanted = reportRecordings(report);
    if (!wanted.length) {
      throw new ApiError("NOT_FOUND", "No call recordings for the leads in this report", 404);
    }
    const urls = new Map(
      (
        await prisma.call.findMany({
          where: { id: { in: wanted.map((w) => w.callId) } },
          select: { id: true, recordingUrl: true },
        })
      ).map((c) => [c.id, c.recordingUrl]),
    );

    // Recordings are already compressed audio; deflating them again costs CPU
    // for nothing, so entries are stored.
    const archive = archiver("zip", { store: true });
    const out = new PassThrough();
    archive.on("error", (err) => out.destroy(err));
    archive.pipe(out);

    const csv = cresentCsv(report);
    void (async () => {
      const missing: string[] = [];
      try {
        archive.append(csv.content, { name: csv.filename });
        for (const w of wanted) {
          const url = urls.get(w.callId);
          try {
            if (!url) throw new Error("no recording on the call");
            const res = await fetchRecording(url);
            if (!res.ok || !res.body) throw new Error(`the phone provider answered ${res.status}`);
            // Buffered per file (a few MB at most) so an entry is only added
            // once its bytes are all here — a half-fetched file must not end
            // up in the zip under a real name.
            const bytes = Buffer.from(await res.arrayBuffer());
            await appendAndWait(archive, bytes, w.path);
          } catch (err) {
            missing.push(`${w.path}\t${err instanceof Error ? err.message : "fetch failed"}`);
          }
        }
        if (missing.length) {
          archive.append(
            [
              "These recordings are listed in the CSV but could not be downloaded.",
              "Recordings made before 20 Aug 2026 live on the previous Plivo account,",
              "which the CRM's credentials no longer cover.",
              "",
              ...missing,
              "",
            ].join("\n"),
            { name: "_missing-recordings.txt" },
          );
        }
        await archive.finalize();
        logger.info(
          { start: range.start, end: range.end, files: wanted.length - missing.length, missing: missing.length, by: ctx.sub },
          "cresent audio zip downloaded",
        );
      } catch (err) {
        logger.error({ err }, "cresent audio zip failed");
        archive.abort();
        out.destroy(err instanceof Error ? err : new Error("zip failed"));
      }
    })();

    const name = `cresent-audio-${report.rangeStart}_to_${report.rangeEnd}.zip`;
    return new NextResponse(Readable.toWeb(out) as ReadableStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "private, no-store",
      },
    });
  });
}

/** Append one entry and wait until the archive has written it, so the next
 *  fetch only starts once this file is on its way out. */
function appendAndWait(archive: Archiver, bytes: Buffer, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: { name: string }) => {
      if (entry.name !== name) return;
      archive.off("entry", onEntry);
      archive.off("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      archive.off("entry", onEntry);
      reject(err);
    };
    archive.on("entry", onEntry);
    archive.once("error", onError);
    archive.append(bytes, { name });
  });
}
