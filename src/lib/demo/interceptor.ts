"use client";

import { handleMockRequest } from "./api-router";

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
