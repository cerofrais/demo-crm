import { describe, expect, it } from "vitest";
import { matchAutoReply } from "./whatsapp-autoreply";

interface Fixture {
  id: string;
  triggerWord: string | null;
  enabled: boolean;
}

describe("matchAutoReply", () => {
  it("returns null when nothing matches and there's no catch-all", () => {
    const rules: Fixture[] = [{ id: "1", triggerWord: "price", enabled: true }];
    expect(matchAutoReply(rules, "hi there")).toBeNull();
  });

  it("matches a trigger word as a case-insensitive substring anywhere in the body", () => {
    const rules: Fixture[] = [{ id: "1", triggerWord: "Price", enabled: true }];
    expect(matchAutoReply(rules, "what's the PRICE for a week?")?.id).toBe("1");
  });

  it("prefers a specific trigger over a blank catch-all", () => {
    const rules: Fixture[] = [
      { id: "catchall", triggerWord: "", enabled: true },
      { id: "specific", triggerWord: "hello", enabled: true },
    ];
    expect(matchAutoReply(rules, "hello there")?.id).toBe("specific");
  });

  it("falls back to the catch-all when no trigger word matches", () => {
    const rules: Fixture[] = [
      { id: "catchall", triggerWord: null, enabled: true },
      { id: "specific", triggerWord: "hello", enabled: true },
    ];
    expect(matchAutoReply(rules, "good morning")?.id).toBe("catchall");
  });

  it("ignores disabled rules entirely, including a disabled catch-all", () => {
    const rules: Fixture[] = [
      { id: "off", triggerWord: null, enabled: false },
      { id: "on", triggerWord: "hello", enabled: true },
    ];
    expect(matchAutoReply(rules, "good morning")).toBeNull();
    expect(matchAutoReply(rules, "hello!")?.id).toBe("on");
  });

  it("first-created specific match wins when multiple trigger words match", () => {
    const rules: Fixture[] = [
      { id: "first", triggerWord: "book", enabled: true },
      { id: "second", triggerWord: "booking", enabled: true },
    ];
    expect(matchAutoReply(rules, "I'd like to make a booking")?.id).toBe("first");
  });
});
