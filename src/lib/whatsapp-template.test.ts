import { describe, expect, it } from "vitest";
import { templateNeedsHeaderImage, templateBodyParams } from "./whatsapp-template";

describe("templateNeedsHeaderImage", () => {
  it("spots an image header", () => {
    expect(templateNeedsHeaderImage({ components: [{ type: "HEADER", format: "IMAGE" }] })).toBe(true);
  });
  it("ignores a text header and a bodyless template", () => {
    expect(templateNeedsHeaderImage({ components: [{ type: "HEADER", format: "TEXT", text: "Hi" }] })).toBe(false);
    expect(templateNeedsHeaderImage({ components: [] })).toBe(false);
  });
});

describe("templateBodyParams", () => {
  it("returns nothing for a body with no placeholders", () => {
    expect(templateBodyParams({ components: [{ type: "BODY", text: "The clock is ticking!" }] }))
      .toEqual({ names: [], isNamed: false });
  });

  it("orders positional placeholders numerically, not lexically", () => {
    // {{10}} must not sort before {{2}} — the values would be swapped in the
    // sent message, which Meta accepts happily and the guest sees as gibberish.
    const t = { components: [{ type: "BODY", text: "{{2}} and {{10}} and {{1}}" }] };
    expect(templateBodyParams(t)).toEqual({ names: ["1", "2", "10"], isNamed: false });
  });

  it("keeps named placeholders in first-appearance order", () => {
    const t = { components: [{ type: "BODY", text: "Hi {{customer_name}}, your {{offer}} ends soon" }] };
    expect(templateBodyParams(t)).toEqual({ names: ["customer_name", "offer"], isNamed: true });
  });

  it("de-duplicates a placeholder used twice", () => {
    const t = { components: [{ type: "BODY", text: "{{1}} … {{1}} again" }] };
    expect(templateBodyParams(t).names).toEqual(["1"]);
  });
});
