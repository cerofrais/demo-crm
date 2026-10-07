import { describe, expect, it } from "vitest";
import { isStatusStale } from "./message-display";

const NOW = new Date("2026-08-26T12:00:00Z").getTime();
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe("isStatusStale", () => {
  it("leaves a just-sent message alone — it really is still in flight", () => {
    expect(isStatusStale("sent", minsAgo(1), "cloud_api", NOW)).toBe(false);
    expect(isStatusStale("sent", minsAgo(29), "cloud_api", NOW)).toBe(false);
  });

  it("flags a message still unconfirmed after the threshold", () => {
    // WhatsApp confirms within seconds. Half an hour of silence is not
    // "pending", it is a status update that never arrived — and Meta offers
    // no way to fetch it afterwards, so it never will.
    expect(isStatusStale("sent", minsAgo(31), "cloud_api", NOW)).toBe(true);
    expect(isStatusStale("sent", minsAgo(60 * 24), "cloud_api", NOW)).toBe(true);
  });

  it("never flags a status that already has a real outcome", () => {
    for (const s of ["delivered", "read", "failed", "received"]) {
      expect(isStatusStale(s, minsAgo(60 * 24), "cloud_api", NOW)).toBe(false);
    }
  });

  it("does not flag on an unparseable timestamp rather than guessing", () => {
    expect(isStatusStale("sent", "not-a-date", "cloud_api", NOW)).toBe(false);
    expect(isStatusStale("sent", "", "cloud_api", NOW)).toBe(false);
  });
});

describe("isStatusStale — channel scoping", () => {
  it("never flags a Baileys message, however old", () => {
    // A third of Baileys outbound never gets a status at all (33% vs 1.4% on
    // Cloud API). Flagging it would mark hundreds of leads for behaviour that
    // is normal on that channel, drowning out the real ones.
    expect(isStatusStale("sent", minsAgo(60 * 24 * 30), "baileys", NOW)).toBe(false);
    expect(isStatusStale("sent", minsAgo(31), "baileys", NOW)).toBe(false);
  });

  it("never flags when the sending number is unknown", () => {
    expect(isStatusStale("sent", minsAgo(60 * 24), null, NOW)).toBe(false);
    expect(isStatusStale("sent", minsAgo(60 * 24), undefined, NOW)).toBe(false);
  });
});
