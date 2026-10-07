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

export interface CleanedMessage {
  /** Display text: trackers gone. Real links are left exactly as sent. */
  clean: string;
  /** Exactly what was stored — never modified. */
  original: string;
  /** Tracking pixels stripped. */
  trackersRemoved: number;
  /** True when `clean` differs from `original`, i.e. a toggle is worth showing. */
  changed: boolean;
}

export function cleanMessageBody(body: string | null | undefined): CleanedMessage {
  const original = body ?? "";
  if (!original.trim()) {
    return { clean: original, original, trackersRemoved: 0, changed: false };
  }

  let trackersRemoved = 0;

  let clean = original.replace(TRACKING_URL, () => {
    trackersRemoved++;
    return "";
  });
  clean = clean.replace(TRACKING_PATH, () => {
    trackersRemoved++;
    return "";
  });

  // Real links are deliberately left WHOLE. They used to be collapsed to
  // `[domain]`, which reads tidily but throws away the part that matters:
  // "[trewellness.in]" cannot tell a rep whether the guest was sent the
  // disease-management page or the pricing page, and the address is often the
  // subject of the conversation. Tracking pixels above are a different case —
  // those carry no meaning and are still removed.

  // A bracket-wrapped tracker leaves an empty "[]" behind — drop the wrapper
  // too, but only when it is genuinely empty, so real bracketed text survives.
  clean = clean.replace(/\[\s*\]|\(\s*\)/g, "");
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
    changed: clean !== original.trim(),
  };
}

/** Characters beyond which a thread bubble gets a "show full message" toggle. */
export const LONG_MESSAGE_CHARS = 700;

export function isLongMessage(text: string): boolean {
  return text.length > LONG_MESSAGE_CHARS;
}

/**
 * How long an outbound WhatsApp message may sit at "sent" before its status
 * should be treated as unknown rather than pending.
 *
 * WhatsApp confirms delivery within seconds. Beyond this, a single tick no
 * longer means "on its way" — it means the status update never arrived. That
 * happens when the status webhook is down, and it is not recoverable: Meta
 * only PUSHES delivery status and has no endpoint to read it back, so those
 * messages stay unresolved for ever. Showing a normal tick would imply
 * progress that will never come.
 */
export const STATUS_STALE_MINUTES = 30;

/**
 * ONLY Cloud API. Baileys never reported delivery reliably — 33% of its
 * outbound has no status at all, against 1.4% on Cloud API — so a missing
 * confirmation there is the norm, not a problem. Flagging it would put a red
 * badge on hundreds of leads for ordinary behaviour and bury the ones that
 * matter. On Cloud API the status is expected, so its absence is real.
 */
export function isStatusStale(
  status: string,
  sentAt: string,
  integration: string | null | undefined,
  now = Date.now(),
): boolean {
  if (integration !== "cloud_api") return false;
  if (status !== "sent") return false;
  const at = new Date(sentAt).getTime();
  if (!Number.isFinite(at)) return false;
  return now - at > STATUS_STALE_MINUTES * 60 * 1000;
}
