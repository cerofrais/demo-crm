import { describe, expect, it } from "vitest";
import { matchAutoTags } from "./auto-tag";

const rule = (trigger: string, tag: string, enabled = true) => ({ trigger, tag, enabled });

describe("matchAutoTags", () => {
  it("matches a single word anywhere in the message, case-insensitively", () => {
    expect(matchAutoTags([rule("price", "price-asked")], "What is the PRICE for 3 days?"))
      .toEqual(["price-asked"]);
  });

  it("matches a whole sentence just as well — it's only a longer needle", () => {
    const rules = [rule("do you have single occupancy", "single-occupancy")];
    expect(matchAutoTags(rules, "Hi, do you have single occupancy rooms available?"))
      .toEqual(["single-occupancy"]);
  });

  it("applies EVERY matching rule, unlike an auto-reply's single winner", () => {
    const rules = [rule("price", "price-asked"), rule("couple", "double-occupancy")];
    expect(matchAutoTags(rules, "price for a couple?").sort())
      .toEqual(["double-occupancy", "price-asked"]);
  });

  it("returns a tag once even when two rules point at it", () => {
    const rules = [rule("price", "price-asked"), rule("cost", "price-asked")];
    expect(matchAutoTags(rules, "what is the price and cost?")).toEqual(["price-asked"]);
  });

  it("ignores disabled rules", () => {
    expect(matchAutoTags([rule("price", "price-asked", false)], "price?")).toEqual([]);
  });

  it("never matches on a blank trigger", () => {
    // A catch-all belongs to auto-REPLY; a rule that tags every inbound
    // message would make the tag meaningless.
    expect(matchAutoTags([rule("   ", "everything")], "anything at all")).toEqual([]);
  });

  it("returns nothing when the message matches no rule", () => {
    expect(matchAutoTags([rule("price", "price-asked")], "thanks!")).toEqual([]);
  });
});
