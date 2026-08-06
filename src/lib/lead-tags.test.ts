import { describe, expect, it } from "vitest";
import { computeSystemTags, formatTag, isSystemTag, tagCategory } from "./lead-tags";

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
