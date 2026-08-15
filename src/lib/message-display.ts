/**
 * Makes a stored message readable in the UI without losing anything.
 *
 * Inbound email in particular arrives carrying machinery the reader doesn't
 * want: email-service-provider tracking pixels (Brevo's
 * `baggchdb.r.bh.d.sendibt3.com/tr/op/<200-char token>` and friends), which are
 * invisible in a mail client but render as a wall of characters here, and
 * ordinary links whose tracking query strings dwarf the text around them.
 *
 * Two different treatments, deliberately:
 *
 *   • A tracking pixel is REMOVED. It carries no information for a human —
 *     it exists only to tell the sender the mail was opened — so there is
 *     nothing to lose by dropping it.
 *   • A real link is SHORTENED to its domain, never deleted. A guest sharing
 *     a page is telling us something, and silently discarding it would hide
 *     content from the person reading the thread.
 *
 * The original text is always kept and reachable — `clean` is a display
 * convenience, never the record. Callers show `original` behind a toggle.
 */

/**
 * Characters a URL may contain here.
 *
 * Brackets and parentheses are EXCLUDED deliberately. These bodies are HTML
 * mail flattened to text, so a link routinely arrives wrapped as
 * `[https://…/tr/op/TOKEN]Dear Guest` with no space before the following word.
 * Without excluding `]`, the match ran past the bracket and swallowed "Dear" —
 * silently deleting a word of the message, which is the one thing this file
 * must never do.
 */
const URL_CHARS = String.raw`[^\s<>"'\[\]()]`;

/**
 * Hosts and paths that only ever serve open/click tracking. Kept narrow on
 * purpose: anything not clearly a tracker is treated as a real link and
 * shortened rather than removed.
 */
const TRACKING_URL = new RegExp(
  String.raw`https?://${URL_CHARS}*?(?:` +
    [
      // Brevo / Sendinblue — the one seen in this deployment's inbox.
      String.raw`sendibt\d*\.com`,
      String.raw`sendinblue\.com`,
      // Other common ESP tracking hosts.
      String.raw`list-manage\.com/track`,
      String.raw`ct\.sendgrid\.net`,
      String.raw`sendgrid\.net/wf/open`,
      String.raw`mandrillapp\.com/track`,
      String.raw`\.mailgun\.org/o/`,
      String.raw`klaviyomail\.com/oo`,
      String.raw`hubspotlinks\.com`,
      String.raw`awstrack\.me`,
      String.raw`\.rs6\.net/on\.jsp`,
    ].join("|") +
    String.raw`)${URL_CHARS}*`,
  "gi",
);

/** A generic open-tracking path on any host (…/tr/op/…, …/wf/open?…, …/o/…). */
const TRACKING_PATH = new RegExp(
  String.raw`https?://${URL_CHARS}*/(?:tr/(?:op|cl)|wf/open|open\.aspx|impression)${URL_CHARS}*`,
  "gi",
);

const ANY_URL = new RegExp(String.raw`https?://${URL_CHARS}+`, "gi");

export interface CleanedMessage {
  /** Display text: trackers gone, other links shortened to their domain. */
  clean: string;
  /** Exactly what was stored — never modified. */
  original: string;
  /** Tracking pixels stripped. */
  trackersRemoved: number;
  /** Real links shortened (not removed). */
  linksShortened: number;
  /** True when `clean` differs from `original`, i.e. a toggle is worth showing. */
  changed: boolean;
}

/** `https://example.com/a/b?x=1` -> `example.com` (no www.). */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "link";
  }
}

export function cleanMessageBody(body: string | null | undefined): CleanedMessage {
  const original = body ?? "";
  if (!original.trim()) {
    return { clean: original, original, trackersRemoved: 0, linksShortened: 0, changed: false };
  }

  let trackersRemoved = 0;
  let linksShortened = 0;

  let clean = original.replace(TRACKING_URL, () => {
    trackersRemoved++;
    return "";
  });
  clean = clean.replace(TRACKING_PATH, () => {
    trackersRemoved++;
    return "";
  });

  clean = clean.replace(ANY_URL, (url) => {
    linksShortened++;
    // Kept as a marker rather than dropped: the reader can see a link was
    // there, and open the original if they need the full address.
    return `[${domainOf(url)}]`;
  });

  // A bracket-wrapped tracker leaves an empty "[]" behind — drop the wrapper
  // too, but only when it is genuinely empty, so real bracketed text survives.
  clean = clean.replace(/\[\s*\]|\(\s*\)/g, "");
  // A bracket-wrapped REAL link becomes "[[domain]]" — the mail's own wrapper
  // plus ours. Collapse to one pair.
  clean = clean.replace(/\[(\[[^[\]]+\])\]/g, "$1");

  // Collapse the blank space a removed pixel leaves behind, without touching
  // the message's own paragraph breaks.
  clean = clean
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*\n/gm, (m, offset: number) => (offset === 0 ? "" : m))
    .trim();

  return {
    clean,
    original,
    trackersRemoved,
    linksShortened,
    changed: clean !== original.trim(),
  };
}

/** Characters beyond which a thread bubble gets a "show full message" toggle. */
export const LONG_MESSAGE_CHARS = 700;

export function isLongMessage(text: string): boolean {
  return text.length > LONG_MESSAGE_CHARS;
}
