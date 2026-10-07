import { describe, it, expect } from "vitest";
import { joinFooter } from "./email-footer";

// The cid convention itself is mail-html.ts's and is tested there — the
// footer deliberately reuses it rather than inventing a second one.

describe("joinFooter", () => {
  const footer = { html: "<p>Trē Wellness</p>", text: "Trē Wellness · trewellness.in" };

  it("appends to both parts", () => {
    const out = joinFooter({ text: "Hello", html: "<p>Hello</p>" }, footer);
    expect(out.text).toBe("Hello\n\n-- \nTrē Wellness · trewellness.in");
    expect(out.html).toContain("<p>Hello</p>");
    expect(out.html).toContain("Trē Wellness");
  });

  it("uses the conventional signature marker so clients can collapse it", () => {
    const out = joinFooter({ text: "Hello" }, footer);
    expect(out.text).toContain("\n-- \n");
  });

  it("does not invent an HTML part for a plain-text send", () => {
    // Upgrading a text-only message to multipart changes how it renders for
    // every recipient, which is not something a signature should decide.
    const out = joinFooter({ text: "Hello" }, footer);
    expect(out.html).toBeUndefined();
  });

  it("leaves the body untouched when the footer is empty", () => {
    const out = joinFooter({ text: "Hello", html: "<p>Hello</p>" }, { html: "", text: "" });
    expect(out.text).toBe("Hello");
    expect(out.html).toBe("<p>Hello</p>");
  });

  it("adds no separator when only one half of the footer is filled in", () => {
    const textOnly = joinFooter({ text: "Hello", html: "<p>Hello</p>" }, { html: "", text: "Trē" });
    expect(textOnly.text).toBe("Hello\n\n-- \nTrē");
    expect(textOnly.html).toBe("<p>Hello</p>");

    const htmlOnly = joinFooter({ text: "Hello", html: "<p>Hello</p>" }, { html: "<b>Trē</b>", text: "" });
    expect(htmlOnly.text).toBe("Hello");
    expect(htmlOnly.html).toContain("<b>Trē</b>");
  });

  it("treats a whitespace-only footer as empty", () => {
    const out = joinFooter({ text: "Hello" }, { html: "   ", text: "\n  \n" });
    expect(out.text).toBe("Hello");
  });
});
