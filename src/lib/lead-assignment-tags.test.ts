import { describe, it, expect } from "vitest";
import { slugifyTag } from "./lead-tags";

/**
 * Tag rules are keyed on the SLUG, because that is how tags are stored on
 * Enquiry.tags. A rule saved from a label that slugifies differently from the
 * tag it is meant to match would simply never fire — the worst failure mode
 * for routing config, since it looks configured and does nothing.
 */
describe("tag rule keys match stored tags", () => {
  it("normalises case and spacing the same way both sides do", () => {
    expect(slugifyTag("Rakhi Gift 2026")).toBe(slugifyTag("rakhi gift 2026"));
    expect(slugifyTag("  High Intent  ")).toBe(slugifyTag("High-Intent"));
  });

  it("gives an empty slug for input that cannot be a tag", () => {
    // setTagAssignmentRule returns null on an empty slug rather than writing
    // a rule that could never match anything.
    expect(slugifyTag("   ")).toBe("");
    expect(slugifyTag("")).toBe("");
  });

  it("keeps genuinely different tags apart", () => {
    expect(slugifyTag("detox")).not.toBe(slugifyTag("detox-2026"));
  });
});
