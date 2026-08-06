import crypto from "node:crypto";
import { env } from "./env";

/**
 * Referral codes: 8-char, URL-safe, unambiguous (no 0/O/1/I), uppercase.
 * (tech spec §6.5)
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateReferralCode(length = 8): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Public referral link a guest/affiliate shares. */
export function referralUrl(code: string): string {
  const base = "https://trewellness.in/enquiry";
  return `${base}?ref=${code}`;
}

// Re-exported for callers that want the app origin too.
export const appOrigin = env.APP_URL;
