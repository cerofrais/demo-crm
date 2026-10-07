import { describe, expect, it } from "vitest";
import { checkTemplateValues, fillTemplateBody, suggestTemplateValues } from "./whatsapp-template-fill";
import { templateBodyParams } from "./whatsapp-template";

describe("fillTemplateBody", () => {
  it("fills positional placeholders in the order Meta numbers them", () => {
    const body = "Hi {{1}}, your {{2}} is confirmed for {{3}}.";
    const { names } = templateBodyParams({ components: [{ type: "BODY", text: body }] });
    expect(fillTemplateBody(body, names, ["Seema", "detox", "2 Oct"])).toBe(
      "Hi Seema, your detox is confirmed for 2 Oct.",
    );
  });

  it("fills a named placeholder wherever it appears, including twice", () => {
    const body = "Hi {{customer_name}} — see you soon, {{customer_name}}!";
    const { names, isNamed } = templateBodyParams({ components: [{ type: "BODY", text: body }] });
    expect(isNamed).toBe(true);
    expect(fillTemplateBody(body, names, ["Seema"])).toBe("Hi Seema — see you soon, Seema!");
  });

  it("leaves nothing of a placeholder behind when a value is missing", () => {
    // "{{2}}" shown to a guest is worse than a gap; the send is refused
    // anyway by checkTemplateValues, this is the belt to that's braces.
    expect(fillTemplateBody("Hi {{1}}, about {{2}}.", ["1", "2"], ["Seema"])).toBe("Hi Seema, about .");
  });
});

describe("checkTemplateValues", () => {
  it("passes when every placeholder has something", () => {
    expect(checkTemplateValues(["1", "2"], ["Seema", "detox"])).toBeNull();
    expect(checkTemplateValues([], [])).toBeNull();
  });

  it("names the placeholder that is empty, rather than letting Meta reject it", () => {
    expect(checkTemplateValues(["1", "2"], ["Seema", "  "])).toEqual({ kind: "missing", index: 1, name: "2" });
    expect(checkTemplateValues(["1"], [])).toEqual({ kind: "missing", index: 0, name: "1" });
  });

  it("refuses more values than the template has places for", () => {
    expect(checkTemplateValues(["1"], ["a", "b"])).toEqual({ kind: "tooMany" });
  });
});

describe("suggestTemplateValues", () => {
  it("offers the guest's first name for the opening placeholder", () => {
    expect(suggestTemplateValues(["1", "2"], { fullName: "Seema Rani" })).toEqual(["Seema", ""]);
  });

  it("matches a named placeholder that asks for a name", () => {
    expect(suggestTemplateValues(["customer_name"], { fullName: "Seema Rani" })).toEqual(["Seema"]);
  });

  it("guesses nothing for a placeholder it cannot know", () => {
    // A date, a price or a programme is the rep's to type: a wrong guess
    // reaches the guest.
    expect(suggestTemplateValues(["1", "appointment_date"], { fullName: "Seema Rani" })).toEqual(["Seema", ""]);
    expect(suggestTemplateValues(["business_name"], { fullName: "Seema Rani" })).toEqual([""]);
  });

  it("suggests nothing when the guest has no name on record", () => {
    expect(suggestTemplateValues(["1"], { fullName: null })).toEqual([""]);
  });
});
