import { describe, it, expect } from "vitest";
import { autoReplyOutcome } from "./email-autoreply";

const relayWithEmail = { send: true, relay: true, to: "guest@example.com" };
const relayNoEmail = { send: false, relay: true, to: null };
const directPerson = { send: true, relay: false, to: "guest@example.com" };
const junk = { send: false, relay: false, to: null };

/**
 * Tagging a lead and replying to it are separate decisions. A tag records what
 * the lead asked for, which stays true when no reply can go out.
 */
describe("autoReplyOutcome", () => {
  it("tags and replies for a form request with an email address", () => {
    expect(autoReplyOutcome({ decision: relayWithEmail, matched: true, welcomeSent: false })).toEqual({
      considered: true, tag: true, send: true,
    });
  });

  it("still tags a form request that has no email to reply to", () => {
    expect(autoReplyOutcome({ decision: relayNoEmail, matched: true, welcomeSent: false })).toEqual({
      considered: true, tag: true, send: false,
    });
  });

  it("tags but does not reply when a welcome email just went out", () => {
    expect(autoReplyOutcome({ decision: relayWithEmail, matched: true, welcomeSent: true })).toEqual({
      considered: true, tag: true, send: false,
    });
  });

  it("does nothing when no rule matched", () => {
    expect(autoReplyOutcome({ decision: relayWithEmail, matched: false, welcomeSent: false })).toEqual({
      considered: true, tag: false, send: false,
    });
  });

  it("never tags or answers junk — a bounce, a no-reply, a machine", () => {
    expect(autoReplyOutcome({ decision: junk, matched: true, welcomeSent: false })).toEqual({
      considered: false, tag: false, send: false,
    });
  });

  it("answers a person writing in directly", () => {
    expect(autoReplyOutcome({ decision: directPerson, matched: true, welcomeSent: false }).send).toBe(true);
  });
});
