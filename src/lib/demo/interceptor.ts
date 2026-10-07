"use client";

import { handleMockRequest } from "./api-router";
import { demoDownload } from "./ext-routes";
import { demoGuestCsv, demoRecordingIndex, demoRemarkDraft } from "./ext-oct";

let installed = false;

/**
 * Monkey-patches window.fetch so every /api/** call the app makes is served
 * from the in-browser demo store instead of hitting a real network request —
 * there's no backend behind this deployment. Must be installed before any
 * component's useEffect can fire a fetch, so it's called at module scope in
 * providers.tsx (evaluated on client bundle load, before React renders).
 */
export function installDemoFetchInterceptor() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  // CSV links are plain navigations the fetch patch can't see. Build the file
  // from the demo store and save it instead of hitting the (absent) backend.
  document.addEventListener(
    "click",
    (ev) => {
      const a = (ev.target as Element | null)?.closest?.("a[href^='/api/']") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute("href")!;
      const file = demoRecordingIndex(href) ?? demoDownload(href);
      if (!file) return;
      ev.preventDefault();
      const blobUrl = URL.createObjectURL(new Blob([file.text], { type: "text/csv" }));
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = file.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    },
    true,
  );

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let pathname: string;
    try {
      pathname = new URL(url, window.location.origin).pathname;
    } catch {
      return originalFetch(input, init);
    }

    if (!pathname.startsWith("/api/")) {
      return originalFetch(input, init);
    }

    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

    // The guest CSV export is a POST that answers with a file, not JSON, so
    // it is built here rather than in the route table.
    if (pathname === "/api/guests/export" && method === "POST") {
      let ids: string[] = [];
      try {
        ids = (JSON.parse(String(init?.body ?? "{}")).guestIds ?? []) as string[];
      } catch {
        /* an export with no selection is an empty file, not a crash */
      }
      return new Response(demoGuestCsv(ids), { status: 200, headers: { "Content-Type": "text/csv" } });
    }

    // Drafting a remark posts the typed text plus any photo or voice note as
    // FormData. It has to answer in its own shape, so it is handled before the
    // generic upload short-circuit below — which would otherwise hand the
    // composer back an id and blank the remark.
    if (/^\/api\/enquiries\/[^/]+\/remark-draft\/?$/.test(pathname) && init?.body instanceof FormData) {
      const typed = String(init.body.get("text") ?? "").trim();
      const file = init.body.get("file");
      const isAudio = file instanceof File && /audio|ogg|webm|m4a|wav/i.test(file.type);
      const isImage = file instanceof File && /image/i.test(file.type);
      return new Response(
        JSON.stringify({
          data: {
            remark: demoRemarkDraft(typed, isAudio, isImage),
            transcript: isAudio ? "Guest asked whether the November dates are still open and what the deposit would be." : null,
            usedImages: isImage ? 1 : 0,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // File uploads (multipart FormData) aren't modeled by the mock router —
    // resolve with a harmless fake success instead of trying to parse the body.
    if (init?.body instanceof FormData) {
      return new Response(JSON.stringify({ data: { id: `demo_${Date.now()}`, url: "#demo-upload" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return handleMockRequest(url, method, init);
  };
}
