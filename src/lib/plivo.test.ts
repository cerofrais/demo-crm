import { describe, expect, it } from "vitest";
import { normalizeInboundPhone } from "./plivo";

describe("normalizeInboundPhone", () => {
  it("prepends + to Plivo's bare-digit inbound From value", () => {
    expect(normalizeInboundPhone("919876543210")).toBe("+919876543210");
  });

  it("leaves an already-E.164 value unchanged", () => {
    expect(normalizeInboundPhone("+919876543210")).toBe("+919876543210");
  });

  it("trims surrounding whitespace before checking for +", () => {
    expect(normalizeInboundPhone("  919876543210  ")).toBe("+919876543210");
  });

  it("leaves an empty value empty rather than returning a bare '+'", () => {
    expect(normalizeInboundPhone("")).toBe("");
    expect(normalizeInboundPhone("   ")).toBe("");
  });

  it("prepends +91 (not just +) to a bare 10-digit local number with no country code", () => {
    // Some carrier routes report caller ID this way instead of Plivo's usual
    // bare-digits-with-country-code — a bare "+" here would produce
    // "+9848052531", one country code short of Guest.phone/E.164.
    expect(normalizeInboundPhone("9848052531")).toBe("+919848052531");
  });

  it("does not mistake a 10-digit number starting 0-5 for a local Indian mobile", () => {
    // Not a valid Indian mobile prefix — left as a bare "+" rather than
    // guessing a country code that might be wrong.
    expect(normalizeInboundPhone("0123456789")).toBe("+0123456789");
  });
});
