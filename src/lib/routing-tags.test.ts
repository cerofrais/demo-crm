import { describe, it, expect } from "vitest";
import { computeSystemTags, slugifyTag, ROUTABLE_SYSTEM_TAGS } from "./lead-tags";

/**
 * The tags a lead can be ROUTED on at creation.
 *
 * These exist because a tag rule that matches nothing is invisible: it sits
 * in Lead Assignment looking exactly like a working rule while routing zero
 * leads. A "foreign-guest" rule did precisely that for weeks — the real tag
 * is "foreign", and the system half of the tag list never reached the
 * assignment resolver in the first place.
 */
describe("system tags available for routing", () => {
  const enquiry = { source: "website_form", isReturningFlag: false, campaignLabel: null };

  it("tags a non-Indian phone number as foreign", () => {
    expect(computeSystemTags({ phone: "+17869254088" }, enquiry)).toContain("foreign");
    expect(computeSystemTags({ phone: "+971527671591" }, enquiry)).toContain("foreign");
    expect(computeSystemTags({ phone: "+6596874590" }, enquiry)).toContain("foreign");
  });

  it("does not tag an Indian number as foreign", () => {
    expect(computeSystemTags({ phone: "+919848369909" }, enquiry)).not.toContain("foreign");
  });

  it("does not call a lead with no phone foreign", () => {
    // An email-only lead is unknown, not foreign — guessing would route real
    // domestic leads to whoever handles international.
    expect(computeSystemTags({ phone: null }, enquiry)).not.toContain("foreign");
    expect(computeSystemTags({}, enquiry)).not.toContain("foreign");
  });

  it("matches a rule keyed on the same tag, through slugification", () => {
    // A rule's key is slugify(label) and the resolver slugifies the lead's
    // tags before comparing, so the two only have to agree AFTER slugifying —
    // "source:instagram" and its key "source-instagram" are the same rule.
    // What must never happen is two different tags collapsing to one key.
    const tags = computeSystemTags({ phone: "+17869254088" }, { ...enquiry, isReturningFlag: true });
    const keys = tags.map(slugifyTag);
    expect(new Set(keys).size, `collision in ${keys.join(", ")}`).toBe(tags.length);
    // And the picker's own vocabulary must survive the same trip.
    for (const t of ROUTABLE_SYSTEM_TAGS) {
      expect(slugifyTag(t), t).toBe(slugifyTag(slugifyTag(t)));
    }
  });

  it("keeps the age bands distinct once slugified", () => {
    // "age:<25" and "age:25-40" both lose their punctuation; if they landed
    // on the same key, one rule would silently answer for both bands.
    const bands = ROUTABLE_SYSTEM_TAGS.filter((t) => t.startsWith("age:"));
    expect(new Set(bands.map(slugifyTag)).size).toBe(bands.length);
  });

  it("still emits the other system tags a rule might target", () => {
    const tags = computeSystemTags(
      { phone: "+919848369909" },
      { source: "instagram", isReturningFlag: true, campaignLabel: "Rakhi 2026" },
    );
    expect(tags).toContain("revisit");
    expect(tags).toContain("source:instagram");
    expect(tags).toContain("campaign:rakhi-2026");
  });

  it("tags revisit only from the lead's own flag, not from the guest being known", () => {
    expect(computeSystemTags({ phone: "+919848369909" }, { source: "facebook", isReturningFlag: false })).not.toContain("revisit");
  });
});
