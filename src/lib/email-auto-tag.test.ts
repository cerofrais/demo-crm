import { describe, expect, it } from "vitest";
import { matchEmailAutoTags, stripQuotedReply } from "./email-auto-tag";

type Rule = { subjectTerms: string[]; bodyTerms: string[]; termMatch: string; tag: string; enabled: boolean };

const rule = (tag: string, r: Partial<Rule> = {}): Rule => ({
  subjectTerms: [],
  bodyTerms: [],
  termMatch: "any",
  enabled: true,
  tag,
  ...r,
});

const mail = (subject: string, body: string) => ({ subject, body });

describe("matchEmailAutoTags", () => {
  it("tags from a subject term, ignoring case", () => {
    expect(matchEmailAutoTags([rule("price-asked", { subjectTerms: ["price"] })], mail("PRICE list?", "")))
      .toEqual(["price-asked"]);
  });

  it("tags from a body term, including a URL", () => {
    const r = rule("ep-page", { bodyTerms: ["trewellness.in/experience"] });
    expect(matchEmailAutoTags([r], mail("", "from https://trewellness.in/experience-packages"))).toEqual(["ep-page"]);
  });

  it("applies EVERY matching rule, unlike an auto-reply", () => {
    const rules = [rule("price-asked", { bodyTerms: ["price"] }), rule("double-occupancy", { bodyTerms: ["couple"] })];
    expect(matchEmailAutoTags(rules, mail("", "price for a couple?")).sort()).toEqual(["double-occupancy", "price-asked"]);
  });

  it("returns a tag once when two rules point at it", () => {
    const rules = [rule("price-asked", { subjectTerms: ["price"] }), rule("price-asked", { bodyTerms: ["cost"] })];
    expect(matchEmailAutoTags(rules, mail("price", "cost"))).toEqual(["price-asked"]);
  });

  it("never matches a rule with no terms — there is no catch-all tag", () => {
    expect(matchEmailAutoTags([rule("everyone", { subjectTerms: [" "] })], mail("hi", "hello"))).toEqual([]);
  });

  it("requires both fields when both are filled", () => {
    const r = rule("t", { subjectTerms: ["enquiry"], bodyTerms: ["retreat"] });
    expect(matchEmailAutoTags([r], mail("Enquiry", "retreat please"))).toEqual(["t"]);
    expect(matchEmailAutoTags([r], mail("Enquiry", "hello"))).toEqual([]);
  });

  it("honours all-must-match", () => {
    const r = rule("t", { bodyTerms: ["diabetes", "detox"], termMatch: "all" });
    expect(matchEmailAutoTags([r], mail("", "diabetes only"))).toEqual([]);
    expect(matchEmailAutoTags([r], mail("", "diabetes and detox"))).toEqual(["t"]);
  });

  it("ignores disabled rules", () => {
    expect(matchEmailAutoTags([rule("t", { subjectTerms: ["price"], enabled: false })], mail("price", ""))).toEqual([]);
  });

  it("does not tag from our own email quoted in the guest's reply", () => {
    const r = rule("price-asked", { bodyTerms: ["pricing"] });
    const body = "Thanks, will check.\n\nOn Tue, 9 Sept 2026 at 10:02, Trē Wellness <hello@trewellness.in> wrote:\n> Our pricing is attached.";
    expect(matchEmailAutoTags([r], mail("Re: Brochure", body))).toEqual([]);
  });
});

describe("stripQuotedReply", () => {
  it("cuts at Gmail's header, even when wrapped over two lines", () => {
    const body = "Yes please.\n\nOn Tue, 9 Sept 2026 at 10:02, Trē Wellness <\nhello@trewellness.in> wrote:\n\nOur packages start at…";
    expect(stripQuotedReply(body).trim()).toBe("Yes please.");
  });

  it("cuts at an Outlook header block", () => {
    const body = "Sounds good\n\nFrom: Trē Wellness <hello@trewellness.in>\nSent: 09 September 2026 10:02\nSubject: Packages";
    expect(stripQuotedReply(body).trim()).toBe("Sounds good");
  });

  it("drops > quoted lines", () => {
    expect(stripQuotedReply("mine\n> theirs\nmine too").trim()).toBe("mine\nmine too");
  });

  it("keeps a Gmail forward, whose From:/Date: header looks like Outlook's quote", () => {
    // The shape of real forms forwarded in from gm@ — cutting here would
    // erase the whole form.
    const body =
      "---------- Forwarded message ---------\nFrom: Trē Wellness <hello@trewellness.in>\nDate: Sat, Aug 23, 2025 at 1:04 PM\nSubject: Packages - Form Submission\n\nName: Sushma\nWellness Focus : Deep Detox & Cleansing";
    expect(stripQuotedReply(body)).toContain("Deep Detox");
  });

  it("still cuts a reply that quotes a forward", () => {
    const body =
      "we charge 28,000 per day\n\nOn Wed, Mar 25, 2026 at 4:30 PM trē wellness <hello@trewellness.in> wrote:\n\n> ---------- Forwarded message ---------\n> From: Trē Wellness\n> Date: Wed\n> Message: detox";
    expect(stripQuotedReply(body).trim()).toBe("we charge 28,000 per day");
  });

  it("leaves a plain form submission untouched", () => {
    const body = "Name: Asha\nPhone: 98765\nMessage: price for 7 days";
    expect(stripQuotedReply(body)).toBe(body);
  });
});
