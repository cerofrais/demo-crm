import { describe, expect, it } from "vitest";
import { toWaMeDigits } from "./wa-me";

describe("toWaMeDigits", () => {
  it("strips the leading + from an E.164 number", () => {
    expect(toWaMeDigits("+919876543210")).toBe("919876543210");
  });

  it("strips spaces and dashes", () => {
    expect(toWaMeDigits("+1 415-555-0100")).toBe("14155550100");
  });

  it("leaves bare digits unchanged", () => {
    expect(toWaMeDigits("919876543210")).toBe("919876543210");
  });
});
