// Age helpers live in ./age (dependency-free, see its header) and are
// re-exported here so the many `from "@/lib/utils"` imports keep working.
export { ageFromDob, ageGroup, ageToDateOfBirth } from "./age";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function initials(name?: string | null): string {
  if (!name) return "?";
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function formatINR(amount?: number | null): string {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Always renders in IST, regardless of the viewer's own system timezone.
 * `toLocaleString("en-IN", ...)` alone does NOT do this — the "en-IN"
 * locale only controls formatting conventions (date order, comma
 * placement), not which timezone the clock is read in; without an explicit
 * `timeZone`, JS falls back to the browser/OS's own timezone, so a machine
 * set to UTC (or anywhere else) silently renders every timestamp wrong for
 * an India-only business. Use this everywhere instead of calling
 * toLocaleString/toLocaleDateString/toLocaleTimeString directly.
 */
export function formatIST(date: Date | string, options: Intl.DateTimeFormatOptions = {}): string {
  return new Date(date).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", ...options });
}

/**
 * Copy text to the clipboard, falling back to the legacy execCommand path
 * when the async Clipboard API isn't available — e.g. plain HTTP on a
 * non-localhost hostname, which browsers treat as a non-secure context and
 * simply don't expose `navigator.clipboard` on at all.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path below
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}
