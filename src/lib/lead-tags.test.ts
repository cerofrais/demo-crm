import { describe, expect, it } from "vitest";
import {
  computeSystemTags,
  formatTag,
  isSystemTag,
  mergeLeadTags,
  packageTag,
  preferredCheckInTag,
  sortTags,
  tagCategory,
  whatsAppNumberTag,
} from "./lead-tags";

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

describe("WhatsApp number tags", () => {
  it("keys on the digits of our own number", () => {
    expect(whatsAppNumberTag("+918712623060")).toBe("wa:918712623060");
    expect(whatsAppNumberTag("918712623060")).toBe("wa:918712623060");
  });

  it("is null when we don't know the number — better untagged than wrong", () => {
    expect(whatsAppNumberTag(null)).toBeNull();
    expect(whatsAppNumberTag("")).toBeNull();
    expect(whatsAppNumberTag("+")).toBeNull();
  });

  it("renders as the national number, which is how staff refer to the lines", () => {
    expect(formatTag("wa:918712623060").label).toBe("WA 8712623060");
    expect(formatTag("wa:918712623061").category).toBe("whatsapp");
  });

  it("keeps a non-Indian number whole rather than guessing its country code", () => {
    expect(formatTag("wa:19723655653").label).toBe("WA 19723655653");
  });

  it("is a system tag, so staff can't hand-remove one that will just come back", () => {
    expect(isSystemTag("wa:918712623060")).toBe(true);
  });

  it("is dropped from enquiry tags by mergeLeadTags — these live on the guest", () => {
    const merged = mergeLeadTags(["wa:918712623060", "mini-detox"], {}, {});
    expect(merged).not.toContain("wa:918712623060");
    expect(merged).toContain("mini-detox");
  });

  it("sorts after the other system tags but before custom ones", () => {
    expect(sortTags(["mini-detox", "wa:918712623060", "source:whatsapp"])).toEqual([
      "source:whatsapp",
      "wa:918712623060",
      "mini-detox",
    ]);
  });
});

describe("preferred check-in date tag", () => {
  it("turns the date the lead asked for into a tag", () => {
    expect(preferredCheckInTag(new Date("2026-10-02T00:00:00.000Z"))).toBe("p:2026-10-02");
    expect(preferredCheckInTag("2026-10-02T00:00:00.000Z")).toBe("p:2026-10-02");
  });

  it("keeps the calendar day the form meant, not a timezone-shifted one", () => {
    // preferredCheckIn is anchored at UTC midnight and means a day; reading it
    // in any local zone would move "2 Oct" to the 1st or the 3rd.
    expect(preferredCheckInTag(new Date("2026-10-02T00:00:00.000Z"))).toBe("p:2026-10-02");
  });

  it("is nothing when there is no date", () => {
    expect(preferredCheckInTag(null)).toBeNull();
    expect(preferredCheckInTag(undefined)).toBeNull();
    expect(preferredCheckInTag("")).toBeNull();
    expect(preferredCheckInTag("sometime in October")).toBeNull();
  });

  it("is a system tag: computed on every save and not removable by hand", () => {
    expect(isSystemTag("p:2026-10-02")).toBe(true);
    expect(computeSystemTags({}, { preferredCheckIn: new Date("2026-10-02T00:00:00.000Z") })).toContain("p:2026-10-02");
    expect(computeSystemTags({}, {})).not.toContain("p:2026-10-02");
  });

  it("replaces itself when the lead moves their date", () => {
    const merged = mergeLeadTags(["p:2026-10-02", "high-intent"], {}, { preferredCheckIn: "2026-11-20T00:00:00.000Z" });
    expect(merged).toContain("p:2026-11-20");
    expect(merged).not.toContain("p:2026-10-02");
    expect(merged).toContain("high-intent"); // a custom tag is never touched
  });

  it("shows as the chip staff asked for", () => {
    const tag = formatTag("p:2026-10-02");
    expect(tag.label).toBe("P:2026-10-02");
    expect(tag.category).toBe("preferred");
    expect(tag.className).not.toBe("");
  });
});
