import { describe, it, expect } from "vitest";
import { resolveAutoReplyRecipient } from "./email-autoreply";

const ours = new Set(["hello@trewellness.in"]);
const plain = new Map<string, unknown>();

/**
 * Who a reply goes to. The website form mailer posts every submission as our
 * own address, so for those the reply belongs to the guest the form named —
 * and every loop guard has to hold on THAT address instead.
 */
describe("resolveAutoReplyRecipient — form relays", () => {
  it("answers a form relay at the guest the form resolved to", () => {
    const d = resolveAutoReplyRecipient({
      fromEmail: "hello@trewellness.in", guestEmail: "Niharika@Example.com", headers: plain, ourAddresses: ours,
    });
    expect(d).toMatchObject({ send: true, to: "niharika@example.com", relay: true });
  });

  it("treats another address on our domain as a relay too", () => {
    const d = resolveAutoReplyRecipient({
      fromEmail: "wp@trewellness.in", guestEmail: "guest@example.com", headers: plain, ourAddresses: ours,
    });
    expect(d).toMatchObject({ send: true, to: "guest@example.com", relay: true });
  });

  it("never answers a relay at our own address or domain — that is the loop", () => {
    for (const guestEmail of ["hello@trewellness.in", "ceo@trewellness.in"]) {
      const d = resolveAutoReplyRecipient({ fromEmail: "hello@trewellness.in", guestEmail, headers: plain, ourAddresses: ours });
      expect(d.send, guestEmail).toBe(false);
      expect(d.to).toBeNull();
    }
  });

  it("skips a relay whose guest has no email", () => {
    const d = resolveAutoReplyRecipient({ fromEmail: "hello@trewellness.in", guestEmail: null, headers: plain, ourAddresses: ours });
    expect(d).toMatchObject({ send: false, to: null });
  });

  it("never answers a relay at a no-reply address", () => {
    const d = resolveAutoReplyRecipient({
      fromEmail: "hello@trewellness.in", guestEmail: "noreply@example.com", headers: plain, ourAddresses: ours,
    });
    expect(d.send).toBe(false);
  });

  it("ignores the relay's own machine headers, which describe the form mailer", () => {
    const headers = new Map<string, unknown>([["auto-submitted", "auto-generated"], ["precedence", "bulk"]]);
    const d = resolveAutoReplyRecipient({
      fromEmail: "hello@trewellness.in", guestEmail: "guest@example.com", headers, ourAddresses: ours,
    });
    expect(d).toMatchObject({ send: true, to: "guest@example.com" });
  });
});

describe("resolveAutoReplyRecipient — direct mail", () => {
  it("answers a person at their own address", () => {
    const d = resolveAutoReplyRecipient({
      fromEmail: "Guest@Example.com", guestEmail: "guest@example.com", headers: plain, ourAddresses: ours,
    });
    expect(d).toMatchObject({ send: true, to: "guest@example.com", relay: false });
  });

  it("does not let a direct sender redirect the reply through the guest record", () => {
    // A guest's stored email may differ from the address they wrote from. The
    // reply goes to who wrote, never to a different stored address.
    const d = resolveAutoReplyRecipient({
      fromEmail: "stranger@example.com", guestEmail: "someone-else@example.com", headers: plain, ourAddresses: ours,
    });
    expect(d.to).toBe("stranger@example.com");
  });

  it("keeps every direct-mail guard", () => {
    expect(resolveAutoReplyRecipient({ fromEmail: "mailer-daemon@googlemail.com", guestEmail: null, headers: plain, ourAddresses: ours }).send).toBe(false);
    const bulk = new Map<string, unknown>([["precedence", "bulk"]]);
    expect(resolveAutoReplyRecipient({ fromEmail: "news@example.com", guestEmail: null, headers: bulk, ourAddresses: ours }).send).toBe(false);
    expect(resolveAutoReplyRecipient({ fromEmail: null, guestEmail: "guest@example.com", headers: plain, ourAddresses: ours }).send).toBe(false);
  });
});
