import { describe, expect, it } from "vitest";
import { renderTemplateForGuest } from "./broadcast";

describe("renderTemplateForGuest", () => {
  it("shows what the guest read, not the template's name", () => {
    // The thread used to say "[template: rakhi_2026_1]", which tells a rep
    // nothing about what was actually said to the person they are calling.
    const job = {
      templateBody: "Hello {{1}}, our Rakhi offer runs until {{2}}.",
      templateBodyParams: ["{name}", "15 Aug"],
    };
    expect(renderTemplateForGuest(job, "Seema Rani", null)).toBe(
      "Hello Seema, our Rakhi offer runs until 15 Aug.",
    );
  });

  it("fills a named placeholder the same way", () => {
    const job = { templateBody: "Hi {{customer_name}}, welcome.", templateBodyParams: ["{name}"] };
    expect(renderTemplateForGuest(job, "Arjun Mehta", "male")).toBe("Hi Arjun, welcome.");
  });

  it("handles a template with no placeholders", () => {
    const job = { templateBody: "Thank you for reaching out.", templateBodyParams: [] };
    expect(renderTemplateForGuest(job, "Seema", null)).toBe("Thank you for reaching out.");
  });

  it("is null for a job sent before the body was captured, so the caller can fall back", () => {
    expect(renderTemplateForGuest({ templateBody: null, templateBodyParams: ["x"] }, "Seema", null)).toBeNull();
  });
});
