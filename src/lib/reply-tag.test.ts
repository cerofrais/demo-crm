import { describe, expect, it } from "vitest";
import { pickReplyTag, normalizeReplyTag, REPLY_WINDOW_DAYS } from "./reply-tag";

describe("pickReplyTag", () => {
  it("prefers the quoted message's tag over a recent broadcast's", () => {
    expect(pickReplyTag({ replyTag: "quoted-one" }, { replyTag: "recent-one" })).toBe("quoted-one");
  });

  it("falls back to the recent broadcast when the reply quoted nothing", () => {
    expect(pickReplyTag(null, { replyTag: "recent-one" })).toBe("recent-one");
  });

  it("returns null when neither side has a tag", () => {
    expect(pickReplyTag(null, null)).toBeNull();
    expect(pickReplyTag({ replyTag: null }, { replyTag: null })).toBeNull();
  });

  it("falls through to `recent` when the quoted message carries no tag", () => {
    // applyReplyTag only ever looks up TAGGED outbound messages, so an
    // untagged quote arrives here as a null `quoted` in practice. Pinned
    // anyway: a quote we can't attribute must not block attribution to the
    // campaign the guest is actually responding to.
    expect(pickReplyTag({ replyTag: null }, { replyTag: "recent-one" })).toBe("recent-one");
  });
});

describe("normalizeReplyTag", () => {
  it("slugifies so a typed tag matches the shared vocabulary", () => {
    expect(normalizeReplyTag("Independence Offer")).toBe("independence-offer");
    expect(normalizeReplyTag("  Diwali 2026!  ")).toBe("diwali-2026");
  });

  it("treats blank/absent as untagged rather than an empty tag", () => {
    expect(normalizeReplyTag("")).toBeNull();
    expect(normalizeReplyTag("   ")).toBeNull();
    expect(normalizeReplyTag(null)).toBeNull();
    expect(normalizeReplyTag(undefined)).toBeNull();
    expect(normalizeReplyTag("!!!")).toBeNull();
  });
});

describe("REPLY_WINDOW_DAYS", () => {
  it("is a sane attribution window", () => {
    expect(REPLY_WINDOW_DAYS).toBeGreaterThan(0);
    expect(REPLY_WINDOW_DAYS).toBeLessThanOrEqual(30);
  });
});
