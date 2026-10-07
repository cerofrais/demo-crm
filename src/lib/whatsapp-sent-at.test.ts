import { describe, expect, it } from "vitest";
import { sentAtFrom } from "./whatsapp";

const NOW = Date.now();
const secs = (msFromNow: number) => Math.floor((NOW + msFromNow) / 1000);

describe("sentAtFrom — WhatsApp's send time, not our arrival time", () => {
  it("uses the timestamp WhatsApp reports", () => {
    const t = secs(-90 * 60 * 1000); // 90 minutes ago
    expect(sentAtFrom(t)?.getTime()).toBe(t * 1000);
  });

  it("accepts it as a string, which some payloads use", () => {
    const t = secs(-60_000);
    expect(sentAtFrom(String(t))?.getTime()).toBe(t * 1000);
  });

  it("keeps a genuinely delayed message at its real send time", () => {
    // The case this exists for: a reply sent before an outage and retried
    // through to us a day and a half later. Stamping arrival made the thread
    // claim the guest had just written, and the reply was refused with 131047
    // because Meta measures the window from the real send.
    const t = secs(-36 * 60 * 60 * 1000);
    expect(sentAtFrom(t)?.getTime()).toBe(t * 1000);
  });

  it("falls back to now() when WhatsApp gives us nothing", () => {
    expect(sentAtFrom(undefined)).toBeUndefined();
    expect(sentAtFrom(0)).toBeUndefined();
    expect(sentAtFrom("not-a-number")).toBeUndefined();
  });

  it("refuses a future timestamp beyond clock skew", () => {
    expect(sentAtFrom(secs(5 * 60_000))).toBeUndefined();
    // small skew is tolerated rather than discarded
    expect(sentAtFrom(secs(30_000))).toBeDefined();
  });

  it("refuses an absurdly old timestamp, which would bury a live message", () => {
    expect(sentAtFrom(secs(-40 * 24 * 60 * 60 * 1000))).toBeUndefined();
  });
});
