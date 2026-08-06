import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { env } from "./env";
import { redis } from "./redis";

/**
 * Object storage (MinIO in dev; S3 / R2 in prod — switch via STORAGE_* env).
 * We presign URLs so the browser uploads/downloads bytes directly, keeping large
 * files off the Next.js server (tech spec §5.3).
 *
 * Presigning is a pure computation (no network), so we sign against the
 * BROWSER-facing endpoint (STORAGE_PUBLIC_ENDPOINT) — the signature is bound to
 * that host, and that's where the browser will send the request. Any command
 * this module actually SENDS over the network (delete, direct get) must go
 * through the INTERNAL endpoint (STORAGE_ENDPOINT) instead — the server itself
 * runs inside the docker network, where the public/LAN hostname may not
 * resolve or may point at a different port than the internal one does.
 */
const credentials = {
  accessKeyId: env.STORAGE_ACCESS_KEY,
  secretAccessKey: env.STORAGE_SECRET_KEY,
};

export const s3 = new S3Client({
  region: "us-east-1",
  endpoint: env.STORAGE_PUBLIC_ENDPOINT ?? env.STORAGE_ENDPOINT,
  forcePathStyle: true, // required for MinIO
  credentials,
});

/** For commands the server sends itself (not presigned for the browser). */
const s3Internal = new S3Client({
  region: "us-east-1",
  endpoint: env.STORAGE_ENDPOINT,
  forcePathStyle: true,
  credentials,
});

const BUCKET = env.STORAGE_BUCKET;

// ---------------------------------------------------------------------------
// Upload policy — MIME allowlist (F46) + per-category size caps (F39) +
// inline-safety (F24). Enforced at BOTH the presign endpoint and /confirm.
// ---------------------------------------------------------------------------
const MB = 1024 * 1024;

/**
 * Subtypes that are safe to serve inline (browser renders without executing
 * script). Deliberately excludes image/svg+xml, text/*, and
 * application/xhtml+xml — serving those inline is a stored-XSS vector (F24).
 */
const INLINE_SAFE_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  // WhatsApp voice notes / video messages — audio/video aren't a stored-XSS
  // vector the way SVG/HTML are, so these are safe to add to the explicit
  // allowlist rather than falling back to broad startsWith("audio/") /
  // startsWith("video/") prefix matching.
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  // The in-browser recorder (WhatsApp voice notes, remark audio notes) —
  // Chrome/Firefox's MediaRecorder default output.
  "audio/webm",
  "video/mp4",
  "video/3gpp",
]);

// A WhatsApp voice note or an in-browser-recorded remark audio note.
const AUDIO_MIME = ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/webm"];

const OFFICE_MIME = [
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

/**
 * Per-category MIME allowlist (F46). Only these types may be presigned/confirmed.
 * SVG/HTML/text are intentionally absent (F24 stored-XSS).
 */
const MIME_ALLOWLIST: Record<string, readonly string[]> = {
  medical: ["application/pdf", "image/png", "image/jpeg", "image/webp"],
  consent: ["application/pdf", "image/png", "image/jpeg", "image/webp"],
  operational: [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    ...OFFICE_MIME,
    // WhatsApp voice-note/media attachments and remark audio notes/files
    // both upload as "operational" — this was previously missing audio
    // entirely, so a voice note attached via the file picker (as opposed to
    // one received inbound, which bypasses this allowlist) would 415.
    ...AUDIO_MIME,
  ],
  marketing: [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    ...OFFICE_MIME,
  ],
};

// Global ceiling override (env MAX_UPLOAD_MB, default 50MB) — acts as an upper
// bound on the per-category caps below.
const GLOBAL_MAX_MB = Number(process.env.MAX_UPLOAD_MB) || 50;
const CATEGORY_MAX_MB: Record<string, number> = {
  medical: 25,
  consent: 25,
  operational: 50,
  marketing: 50,
};

/** Max allowed upload size (bytes) for a document category (F39). */
export function maxUploadBytes(category: string): number {
  return Math.min(CATEGORY_MAX_MB[category] ?? 25, GLOBAL_MAX_MB) * MB;
}

/**
 * Strips codec/charset parameters (e.g. "audio/webm;codecs=opus" ->
 * "audio/webm") — MediaRecorder's own `.mimeType` (the in-browser voice-note
 * recorder, WhatsApp panel + remarks composer) always includes one, but the
 * allowlists below intentionally only list bare subtypes; comparing the raw
 * string against them made every recorded voice note 415.
 */
function baseMime(mime: string): string {
  return mime.split(";", 1)[0].trim().toLowerCase();
}

/** Whether a MIME type is permitted for a given category (F46). */
export function isAllowedUploadType(category: string, mime: string): boolean {
  const base = baseMime(mime);
  return MIME_ALLOWLIST[category]?.some((m) => baseMime(m) === base) ?? false;
}

// ---------------------------------------------------------------------------
// Upload bindings (F8) — record exactly what we minted a presigned PUT for, so
// /confirm can reject a client that swaps key/category/mime/size/guest.
// ---------------------------------------------------------------------------
export interface UploadBinding {
  sub: string;
  key: string;
  category: string;
  mime: string;
  maxSize: number;
  guestId?: string | null;
  enquiryId?: string | null;
}

// 15 min: comfortably outlives the 10-min presign window so a slow upload can
// still be confirmed. Redis is fail-closed here (no offline queue) — if it's
// down, uploads/confirms fail rather than bypass the binding check.
const BINDING_TTL_SECONDS = 900;
const bindingKey = (storageKey: string) => `upload:binding:${storageKey}`;

export async function putUploadBinding(b: UploadBinding): Promise<void> {
  await redis.set(bindingKey(b.key), JSON.stringify(b), "EX", BINDING_TTL_SECONDS);
}

export async function getUploadBinding(
  storageKey: string,
): Promise<UploadBinding | null> {
  const raw = await redis.get(bindingKey(storageKey));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UploadBinding;
  } catch {
    return null;
  }
}

/** Consume the binding once the upload is confirmed (prevents replay). */
export async function clearUploadBinding(storageKey: string): Promise<void> {
  await redis.del(bindingKey(storageKey));
}

/** Build a collision-free, traceable object key. */
export function buildStorageKey(opts: {
  category: string;
  filename: string;
  guestId?: string | null;
  enquiryId?: string | null;
}): string {
  const safe = opts.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  const scope = opts.guestId
    ? `guests/${opts.guestId}`
    : opts.enquiryId
      ? `enquiries/${opts.enquiryId}`
      : "general";
  return `${opts.category}/${scope}/${randomUUID()}-${safe}`;
}

/** Presigned PUT URL for a direct browser upload (default 10 min). */
export function presignUpload(
  key: string,
  contentType: string,
  opts: { contentLength?: number; expiresIn?: number } = {},
): Promise<string> {
  const { contentLength, expiresIn = 600 } = opts;
  // F39: when the client declares the byte size up front, bind it into the
  // signature (content-length becomes a signed header) so the presigned PUT
  // can't be reused to upload a larger object than requested.
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
      ...(contentLength != null ? { ContentLength: contentLength } : {}),
    }),
    { expiresIn },
  );
}

/** Presigned GET URL for download/preview (default 15 min). */
export function presignDownload(
  key: string,
  filename: string,
  opts: { inline?: boolean } = {},
  expiresIn = 900,
): Promise<string> {
  const disposition = `${opts.inline ? "inline" : "attachment"}; filename="${filename.replace(/"/g, "")}"`;
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ResponseContentDisposition: disposition,
    }),
    { expiresIn },
  );
}

export async function deleteObject(key: string): Promise<void> {
  await s3Internal.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

/**
 * Server-side HEAD — reconcile an uploaded object's REAL size/type against the
 * client-declared metadata before we trust it (F8), and to bound an attachment
 * before buffering it into memory (F38).
 */
export async function headObject(
  key: string,
): Promise<{ contentLength: number; contentType?: string }> {
  const res = await s3Internal.send(
    new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  return { contentLength: res.ContentLength ?? 0, contentType: res.ContentType };
}

/** Uploads bytes server-side — used to store WhatsApp media downloaded from
 * Evolution API (the server has the bytes already, no browser round-trip). */
export async function putObjectBuffer(
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  await s3Internal.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }),
  );
}

/** Fetches an object's bytes server-side — used to attach an already-uploaded
 * document to an outbound email. */
export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await s3Internal.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Files that can preview inline rather than force a download. Restricted to
 * PDFs and raster images — SVG/text/HTML are excluded because inline rendering
 * of those is a stored-XSS vector (F24). Everything else is served as an
 * attachment (Content-Disposition set by presignDownload).
 */
export function isInlineType(mime: string): boolean {
  return INLINE_SAFE_MIME.has(baseMime(mime));
}
