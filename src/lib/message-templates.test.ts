import { describe, expect, it } from "vitest";
import { personalizeTemplate } from "./message-templates";

describe("personalizeTemplate", () => {
  it("replaces {name} with the guest's first name", () => {
    expect(personalizeTemplate("Hi {name}, welcome!", { name: "Asha Rao" })).toBe("Hi Asha, welcome!");
  });

  it("is case-insensitive on the token", () => {
    expect(personalizeTemplate("Hi {Name}!", { name: "Asha Rao" })).toBe("Hi Asha!");
  });

  it("replaces every occurrence, not just the first", () => {
    expect(personalizeTemplate("{name}, hi {name}!", { name: "Asha Rao" })).toBe("Asha, hi Asha!");
  });

  it("falls back to the full name when there's no space", () => {
    expect(personalizeTemplate("Hi {name}!", { name: "Cher" })).toBe("Hi Cher!");
  });

  it("resolves {rep_name} and {rep_phone} independently of {name}", () => {
    expect(
      personalizeTemplate("From {rep_name}, {rep_phone}", { repName: "Prashanth", repPhone: "+919876543210" }),
    ).toBe("From Prashanth, +919876543210");
  });

  it("leaves a token untouched when its var is omitted", () => {
    expect(personalizeTemplate("Hi {name}, call {rep_phone}", { name: "Asha Rao" })).toBe(
      "Hi Asha, call {rep_phone}",
    );
  });

  it("resolves multiple token types in one pass", () => {
    expect(
      personalizeTemplate("Hi {name}, this is {rep_name}", { name: "Asha Rao", repName: "Prashanth" }),
    ).toBe("Hi Asha, this is Prashanth");
  });

  it("resolves {salutation} to Mr./Ms. by gender, empty for other/unknown", () => {
    expect(personalizeTemplate("Hi {salutation}{name},", { name: "Arjun Nair", gender: "male" })).toBe(
      "Hi Mr. Arjun,",
    );
    expect(personalizeTemplate("Hi {salutation}{name},", { name: "Divya Pillai", gender: "female" })).toBe(
      "Hi Ms. Divya,",
    );
    expect(personalizeTemplate("Hi {salutation}{name},", { name: "Karan Malhotra", gender: "other" })).toBe(
      "Hi Karan,",
    );
    expect(personalizeTemplate("Hi {salutation}{name},", { name: "Karan Malhotra", gender: null })).toBe(
      "Hi Karan,",
    );
  });

  it("leaves {salutation} untouched when gender is omitted", () => {
    expect(personalizeTemplate("Hi {salutation}{name},", { name: "Asha Rao" })).toBe("Hi {salutation}Asha,");
  });
});
