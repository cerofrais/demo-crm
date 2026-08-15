import { describe, expect, it } from "vitest";
import { personalize, shouldUseMarketingApi } from "./broadcast";

describe("shouldUseMarketingApi", () => {
  it("routes a marketing template to the Marketing Messages API when enabled", () => {
    expect(shouldUseMarketingApi("MARKETING", true)).toBe(true);
  });

  it("keeps everything on the Cloud API while the kill switch is off", () => {
    expect(shouldUseMarketingApi("MARKETING", false)).toBe(false);
  });

  it("never sends a non-marketing template to /marketing_messages", () => {
    // Meta rejects these outright on that endpoint.
    expect(shouldUseMarketingApi("UTILITY", true)).toBe(false);
    expect(shouldUseMarketingApi("AUTHENTICATION", true)).toBe(false);
    expect(shouldUseMarketingApi("SERVICE", true)).toBe(false);
  });

  it("fails closed when the category is unknown", () => {
    // A failed category lookup, or a free-text Baileys broadcast — either way
    // it must fall back to the path that already worked, not guess.
    expect(shouldUseMarketingApi(null, true)).toBe(false);
  });

  it("is case-sensitive on Meta's exact category value", () => {
    expect(shouldUseMarketingApi("marketing", true)).toBe(false);
  });
});

describe("personalize", () => {
  it("replaces {name} with the guest's first name", () => {
    expect(personalize("Hi {name}, welcome!", "Asha Rao")).toBe("Hi Asha, welcome!");
  });

  it("is case-insensitive on the token", () => {
    expect(personalize("Hi {Name}!", "Asha Rao")).toBe("Hi Asha!");
  });

  it("replaces every occurrence, not just the first", () => {
    expect(personalize("{name}, hi {name}!", "Asha Rao")).toBe("Asha, hi Asha!");
  });

  it("falls back to the full name when there's no space", () => {
    expect(personalize("Hi {name}!", "Cher")).toBe("Hi Cher!");
  });

  it("leaves the template unchanged when it has no {name} token", () => {
    expect(personalize("Hello there!", "Asha Rao")).toBe("Hello there!");
  });
});
