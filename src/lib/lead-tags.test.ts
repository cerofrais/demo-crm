import { describe, expect, it } from "vitest";
import { computeSystemTags, formatTag, isSystemTag, mergeLeadTags, packageTag, sortTags, tagCategory } from "./lead-tags";

describe("computeSystemTags — foreign tag", () => {
  it("tags a non-Indian number as foreign", () => {
    expect(computeSystemTags({ phone: "+14155550123" }, {})).toContain("foreign");
  });

  it("does not tag an Indian (+91) number", () => {
    expect(computeSystemTags({ phone: "+919876543210" }, {})).not.toContain("foreign");
  });

  it("does not tag a guest with no phone at all", () => {
    expect(computeSystemTags({ phone: null }, {})).not.toContain("foreign");
    expect(computeSystemTags({}, {})).not.toContain("foreign");
  });
});

describe("foreign tag metadata", () => {
  it("is recognised as a system tag", () => {
    expect(isSystemTag("foreign")).toBe(true);
  });

  it("categorizes as foreign", () => {
    expect(tagCategory("foreign")).toBe("foreign");
  });
});

describe("computeSystemTags — campaign tag", () => {
  it("slugifies the campaign label into a campaign: tag", () => {
    const tags = computeSystemTags({}, { campaignLabel: "Seasonal Detox Hyderabad" });
    expect(tags).toContain("campaign:seasonal-detox-hyderabad");
  });

  it("omits the tag when there's no campaign label", () => {
    expect(computeSystemTags({}, {})).not.toEqual(expect.arrayContaining([expect.stringMatching(/^campaign:/)]));
  });

  it("is recognised as a system tag and formats back to title case", () => {
    expect(isSystemTag("campaign:seasonal-detox-hyderabad")).toBe(true);
    expect(tagCategory("campaign:seasonal-detox-hyderabad")).toBe("campaign");
    expect(formatTag("campaign:seasonal-detox-hyderabad").label).toBe("Seasonal Detox Hyderabad");
  });
});

describe("package preference tag", () => {
  // A PLAIN slug on purpose: staff already tag leads "mini-detox" by hand, so
  // a namespaced "package:mini-detox" would put two identically labelled
  // chips in the picker for the same thing.
  it("slugifies to the same value staff already use", () => {
    expect(packageTag("Mini Detox")).toBe("mini-detox");
    expect(packageTag("Holistic Healing")).toBe("holistic-healing");
  });

  it("returns null when there's nothing to slugify", () => {
    expect(packageTag("   ")).toBeNull();
    expect(packageTag("!!!")).toBeNull();
  });

  it("renders exactly like a staff-made custom tag", () => {
    expect(formatTag("mini-detox").label).toBe("Mini Detox");
    expect(formatTag("mini-detox").category).toBe("custom");
    // Same value from both routes => one chip, not two.
    expect(formatTag(packageTag("Mini Detox")!)).toEqual(formatTag("mini-detox"));
  });

  it("survives a tag merge and stays removable by staff", () => {
    expect(isSystemTag("mini-detox")).toBe(false);
    const merged = mergeLeadTags(["mini-detox"], {}, { source: "website_form" });
    expect(merged).toContain("mini-detox");
    expect(merged).toContain("source:website_form");
  });

  it("sorts after the system tags rather than jumping to the front", () => {
    const sorted = sortTags(["mini-detox", "blocked", "source:website_form"]);
    expect(sorted[0]).toBe("blocked");
    expect(sorted[sorted.length - 1]).toBe("mini-detox");
  });
});
