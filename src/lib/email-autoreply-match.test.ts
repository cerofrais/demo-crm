import { describe, it, expect } from "vitest";
import { matchEmailAutoReply, hasTerms } from "./email-autoreply";

type Rule = {
  id: string;
  subjectTerms: string[];
  bodyTerms: string[];
  termMatch: string;
  enabled: boolean;
};

const rule = (id: string, r: Partial<Rule> = {}): Rule => ({
  id,
  subjectTerms: [],
  bodyTerms: [],
  termMatch: "any",
  enabled: true,
  ...r,
});

const mail = (subject: string, body: string) => ({ subject, body });

describe("hasTerms", () => {
  it("is false for a rule with nothing but blank terms", () => {
    // Blank lines from the editor must not turn a catch-all into a rule that
    // matches everything as if it were specific.
    expect(hasTerms(rule("a", { subjectTerms: ["  "], bodyTerms: [""] }))).toBe(false);
    expect(hasTerms(rule("b", { subjectTerms: ["brochure"] }))).toBe(true);
  });
});

describe("matchEmailAutoReply", () => {
  it("matches a single subject term", () => {
    const r = rule("a", { subjectTerms: ["brochure"] });
    expect(matchEmailAutoReply([r], mail("Please send the Brochure", "hi"))?.id).toBe("a");
    expect(matchEmailAutoReply([r], mail("Pricing please", "hi"))).toBeNull();
  });

  it("matches a body term, including a URL", () => {
    const r = rule("a", { bodyTerms: ["trewellness.in/packages"] });
    expect(
      matchEmailAutoReply([r], mail("hello", "saw this: https://trewellness.in/packages?ref=ig"))?.id,
    ).toBe("a");
  });

  it("with several terms and 'any', one is enough", () => {
    const r = rule("a", { subjectTerms: ["brochure", "pricing"], termMatch: "any" });
    expect(matchEmailAutoReply([r], mail("pricing?", ""))?.id).toBe("a");
    expect(matchEmailAutoReply([r], mail("rooms?", ""))).toBeNull();
  });

  it("with several terms and 'all', every one must appear", () => {
    const r = rule("a", { subjectTerms: ["brochure", "pricing"], termMatch: "all" });
    expect(matchEmailAutoReply([r], mail("brochure and pricing", ""))?.id).toBe("a");
    expect(matchEmailAutoReply([r], mail("brochure only", ""))).toBeNull();
  });

  it("ANDs the two fields — both conditions must hold", () => {
    const r = rule("a", { subjectTerms: ["enquiry"], bodyTerms: ["trewellness.in/packages"] });
    expect(matchEmailAutoReply([r], mail("Enquiry", "see trewellness.in/packages"))?.id).toBe("a");
    // Subject alone is not enough once a body term is also required.
    expect(matchEmailAutoReply([r], mail("Enquiry", "no link here"))).toBeNull();
    expect(matchEmailAutoReply([r], mail("Hello", "see trewellness.in/packages"))).toBeNull();
  });

  it("treats an empty field as no condition, not a failed one", () => {
    // This is what makes a subject-only or body-only rule possible at all.
    const subjectOnly = rule("a", { subjectTerms: ["enquiry"] });
    expect(matchEmailAutoReply([subjectOnly], mail("Enquiry", ""))?.id).toBe("a");
  });

  it("prefers a specific rule over the catch-all whatever the order", () => {
    const catchAll = rule("catch");
    const specific = rule("specific", { subjectTerms: ["brochure"] });
    expect(matchEmailAutoReply([catchAll, specific], mail("brochure", ""))?.id).toBe("specific");
    expect(matchEmailAutoReply([specific, catchAll], mail("brochure", ""))?.id).toBe("specific");
  });

  it("falls back to the catch-all when nothing specific matches", () => {
    const rules = [rule("specific", { subjectTerms: ["brochure"] }), rule("catch")];
    expect(matchEmailAutoReply(rules, mail("something else", ""))?.id).toBe("catch");
  });

  it("returns null when there is no catch-all and nothing matches", () => {
    expect(matchEmailAutoReply([rule("a", { subjectTerms: ["brochure"] })], mail("x", "y"))).toBeNull();
  });

  it("ignores disabled rules entirely", () => {
    const off = rule("off", { subjectTerms: ["brochure"], enabled: false });
    expect(matchEmailAutoReply([off], mail("brochure", ""))).toBeNull();
  });

  it("is case-insensitive on both sides", () => {
    const r = rule("a", { bodyTerms: ["Single Occupancy"] });
    expect(matchEmailAutoReply([r], mail("", "do you have single occupancy?"))?.id).toBe("a");
  });

  it("first match wins among several specific rules", () => {
    const rules = [
      rule("first", { subjectTerms: ["enquiry"] }),
      rule("second", { subjectTerms: ["enquiry"] }),
    ];
    expect(matchEmailAutoReply(rules, mail("enquiry", ""))?.id).toBe("first");
  });
});
