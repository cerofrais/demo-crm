"use client";

/**
 * Thin client-side fetch wrapper.
 * Supports both `{ data, error }` envelopes and raw JSON payloads.
 */
async function handleResponse<T>(res: Response): Promise<T> {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Admin-initiated revocation (role change / disable / delete) — bounce
    // through force-signout so cookies are cleared and /login can auto-SSO.
    // Uses window.location so any in-flight React state is left behind.
    const code = json?.error?.code;
    if (res.status === 401 && code === "REAUTH_REQUIRED" && typeof window !== "undefined") {
      window.location.href = "/api/auth/force-signout?reason=revoked";
      // Return a promise that never resolves — caller shouldn't see either
      // success or a spurious "network" error while the redirect is in flight.
      return new Promise<T>(() => {});
    }
    const message =
      json?.error?.message ??
      json?.error ??
      json?.message ??
      `Request failed (${res.status})`;
    throw new Error(message);
  }

  // Allow both API styles:
  // 1) { data: <payload> }
  // 2) <payload>
  return (
    json !== null && typeof json === "object" && "data" in json
      ? json.data
      : json
  ) as T;
}

async function request<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return handleResponse<T>(res);
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body: unknown) =>
    request<T>(url, { method: "POST", body: JSON.stringify(body) }),
  patch: <T>(url: string, body: unknown) =>
    request<T>(url, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T>(url: string, body: unknown) =>
    request<T>(url, { method: "PUT", body: JSON.stringify(body) }),
  delete: <T>(url: string) => request<T>(url, { method: "DELETE" }),
  // No Content-Type override — the browser sets the multipart boundary itself.
  upload: <T>(url: string, formData: FormData) =>
    fetch(url, { method: "POST", body: formData }).then((res) => handleResponse<T>(res)),
};
