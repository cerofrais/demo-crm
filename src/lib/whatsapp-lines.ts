/**
 * Which phone number a WhatsApp activity row was on.
 *
 * Activity rows record the Evolution *instance* a message went through, and
 * an instance is not a number: every re-pair of a line mints a new one (the
 * 60 line has had eight), and the name can't be trusted either — the 52 line
 * once ran as "tre-sales-phone-…", and the 60 line was re-paired on 21 Sep as
 * "tre-9712623060-…", a typo, while still being +91 87126 23060. So the
 * number comes from records that hold it outright:
 *
 *   • WhatsAppNumber.phoneNumber, for instances that still exist;
 *   • Message.fromEmail on outbound WhatsApp, which is the sending number,
 *     for every instance that ever sent anything.
 *
 * New rows also carry `metadata.line` directly (see the send route and
 * whatsapp-ingest), which wins over both.
 */
import { prisma } from "./prisma";

/** "+918712623060" → "+91 87126 23060". Anything else is returned as-is. */
export function formatLineNumber(e164: string | null | undefined): string {
  if (!e164) return "";
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}

/** The number a row's metadata says it was on, given the instance map. */
export function lineForMetadata(
  metadata: unknown,
  numberByInstance: ReadonlyMap<string, string>,
): string | null {
  const meta = metadata as { line?: unknown; instance?: unknown } | null | undefined;
  if (typeof meta?.line === "string" && meta.line) return meta.line;
  if (typeof meta?.instance === "string") return numberByInstance.get(meta.instance) ?? null;
  return null;
}

/** Every instance name that belongs to a number. */
export function instancesForNumber(
  number: string,
  numberByInstance: ReadonlyMap<string, string>,
): string[] {
  return [...numberByInstance].filter(([, n]) => n === number).map(([instance]) => instance);
}

export interface LineOption {
  number: string;
  /** The line's current label when it still exists, else the formatted number. */
  label: string;
  /** Still paired in the CRM. False for a line that only exists in history. */
  current: boolean;
}

interface LineIndex {
  numberByInstance: Map<string, string>;
  options: LineOption[];
}

// The instance→number map changes only when a line is re-paired, and the
// Message scan behind it is not free, so it's reused for a few minutes.
const TTL_MS = 5 * 60_000;
let cached: { at: number; value: LineIndex } | null = null;

export async function getLineIndex(): Promise<LineIndex> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  const [current, historic] = await Promise.all([
    prisma.whatsAppNumber.findMany({
      select: { instanceName: true, phoneNumber: true, label: true },
    }),
    prisma.$queryRaw<{ mailboxId: string; fromEmail: string }[]>`
      SELECT DISTINCT "mailboxId", "fromEmail"
      FROM "Message"
      WHERE channel = 'whatsapp' AND direction = 'outbound' AND "fromEmail" IS NOT NULL
    `,
  ]);

  const numberByInstance = new Map<string, string>();
  for (const h of historic) numberByInstance.set(h.mailboxId, h.fromEmail);
  // The live table wins: it is the number the line is paired as now.
  for (const c of current) if (c.phoneNumber) numberByInstance.set(c.instanceName, c.phoneNumber);

  const labelByNumber = new Map<string, string>();
  for (const c of current) {
    if (!c.phoneNumber) continue;
    // A bare-digits label ("8712623060", or the mistyped "9712623060") adds
    // nothing over the number itself and can contradict it — only a real
    // name like "Trē Wellness (Cloud API)" is worth showing.
    const named = c.label && !/^\+?\d[\d\s]*$/.test(c.label.trim()) ? c.label.trim() : null;
    if (named) labelByNumber.set(c.phoneNumber, named);
  }
  const currentNumbers = new Set(current.map((c) => c.phoneNumber).filter(Boolean));

  const options = [...new Set(numberByInstance.values())]
    .sort()
    .map((number) => ({
      number,
      label: labelByNumber.has(number)
        ? `${formatLineNumber(number)} · ${labelByNumber.get(number)}`
        : formatLineNumber(number),
      current: currentNumbers.has(number),
    }));

  const value = { numberByInstance, options };
  cached = { at: Date.now(), value };
  return value;
}
