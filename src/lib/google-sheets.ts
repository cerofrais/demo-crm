/**
 * Read-only Google Sheets access as a service account.
 *
 * A service account is a Google identity for servers. It sees a sheet only
 * once the sheet is shared with its email address, which is the whole setup:
 * nobody's personal Google login is stored, and access is exactly the sheets
 * someone chose to share.
 *
 * Deliberately no googleapis dependency — two REST calls and an RS256 JWT
 * are all this needs, and Node's crypto signs the JWT.
 *
 * Configured by GOOGLE_SERVICE_ACCOUNT_JSON: the key file Google gives you,
 * pasted as-is or base64-encoded (easier to keep on one line in .env).
 */
import crypto from "node:crypto";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

export function loadServiceAccount(raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON): ServiceAccount | null {
  const text = raw?.trim();
  if (!text) return null;
  const json = text.startsWith("{") ? text : Buffer.from(text, "base64").toString("utf8");
  let parsed: { client_email?: string; private_key?: string; token_uri?: string };
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON isn't valid JSON (or base64 of it)");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key");
  }
  return {
    client_email: parsed.client_email,
    // .env files often carry the key with literal "\n" sequences.
    private_key: parsed.private_key.replace(/\\n/g, "\n"),
    token_uri: parsed.token_uri || DEFAULT_TOKEN_URI,
  };
}

/** The address sheets must be shared with, or null when not configured. */
export function serviceAccountEmail(): string | null {
  try {
    return loadServiceAccount()?.client_email ?? null;
  } catch {
    return null;
  }
}

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** The signed JWT exchanged for an access token (RFC 7523). */
export function buildJwtAssertion(sa: ServiceAccount, nowSec: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri, iat: nowSec, exp: nowSec + 3600 }),
  );
  const signature = crypto.createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}

let cachedToken: { token: string; expiresAt: number; email: string } | null = null;

async function accessToken(sa: ServiceAccount): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.email === sa.client_email && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.token;
  }
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: buildJwtAssertion(sa, Math.floor(now / 1000)),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`Google sign-in for the service account failed: ${body.error_description ?? res.status}`);
  }
  cachedToken = { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000, email: sa.client_email };
  return body.access_token;
}

/**
 * Pulls the spreadsheet id and tab id out of a pasted link. Accepts the
 * /edit, /view and ?gid= / #gid= forms Google produces; null when the text
 * isn't a Google Sheets link at all.
 */
export function parseSheetUrl(url: string): { spreadsheetId: string; gid: string | null } | null {
  const m = url.trim().match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (!m) return null;
  const gid = url.match(/[#?&]gid=(\d+)/)?.[1] ?? null;
  return { spreadsheetId: m[1], gid };
}

async function sheetsGet<T>(path: string, token: string, sa: ServiceAccount): Promise<T> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 403) {
    throw new Error(`No access — share the sheet with ${sa.client_email} (Viewer is enough)`);
  }
  if (res.status === 404) throw new Error("Sheet not found — check the link");
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Google Sheets error ${res.status}: ${body.error?.message ?? res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Every row of one tab, as display strings. `gid` picks the tab the link
 * pointed at; without one, the first tab.
 */
export async function readSheet(
  spreadsheetId: string,
  gid: string | null,
): Promise<{ spreadsheetTitle: string; tabTitle: string; values: string[][] }> {
  const sa = loadServiceAccount();
  if (!sa) throw new Error("Google access isn't set up — GOOGLE_SERVICE_ACCOUNT_JSON is missing on the server");
  const token = await accessToken(sa);

  const meta = await sheetsGet<{ properties?: { title?: string }; sheets?: { properties: { sheetId: number; title: string } }[] }>(
    `${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties(sheetId,title)`,
    token,
    sa,
  );
  const tabs = meta.sheets ?? [];
  const tab = gid !== null ? tabs.find((t) => String(t.properties.sheetId) === gid) : tabs[0];
  if (!tab) throw new Error(gid !== null ? `The tab in this link (gid ${gid}) no longer exists` : "The spreadsheet has no tabs");

  const range = encodeURIComponent(`'${tab.properties.title.replace(/'/g, "''")}'`);
  const data = await sheetsGet<{ values?: unknown[][] }>(
    `${encodeURIComponent(spreadsheetId)}/values/${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
    token,
    sa,
  );
  return {
    spreadsheetTitle: meta.properties?.title ?? "",
    tabTitle: tab.properties.title,
    values: (data.values ?? []).map((row) => row.map((c) => (c === null || c === undefined ? "" : String(c)))),
  };
}
