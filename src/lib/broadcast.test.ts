import { describe, expect, it } from "vitest";
import { personalize } from "./broadcast";

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
