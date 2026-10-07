import { describe, it, expect } from "vitest";
import {
  looksLikeHtml,
  templateBodyToHtml,
  htmlToPlainText,
  templateBodyPreview,
} from "./message-templates";

/**
 * Email templates became rich; every template written before that is still
 * plain text. Getting this wrong double-spaces every existing template the
 * moment a rep opens one, which is the regression to guard against.
 */
describe("looksLikeHtml", () => {
  it("recognises what the rich editor produces", () => {
    for (const h of [
      "<p>Hello</p>",
      "Hello<br>there",
      '<img src="cid:11111111-2222-3333-4444-555555555555">',
      '<a href="https://trewellness.in">site</a>',
      "<div>x</div>",
      "<strong>x</strong>",
    ]) {
      expect(looksLikeHtml(h), h).toBe(true);
    }
  });

  it("does not mistake ordinary prose for markup", () => {
    for (const t of [
      "Hello {name},\n\nHope you're doing well.",
      "Rates start < 50,000 and go > 1,00,000",
      "Use the 2 > 1 offer",
      "",
    ]) {
      expect(looksLikeHtml(t), t).toBe(false);
    }
  });
});

describe("templateBodyToHtml", () => {
  it("converts newlines in a legacy plain-text template", () => {
    expect(templateBodyToHtml("Hi {name},\n\nThanks!")).toBe("Hi {name},<br><br>Thanks!");
  });

  it("leaves an already-HTML body completely alone", () => {
    // The bug this prevents: <br> added after every tag, double-spacing the
    // whole message.
    const html = "<p>Hi {name},</p>\n<p>Thanks!</p>";
    expect(templateBodyToHtml(html)).toBe(html);
  });
});

describe("htmlToPlainText", () => {
  it("produces a readable text/plain half", () => {
    expect(htmlToPlainText("<p>Hi there</p><p>Thanks!</p>")).toBe("Hi there\nThanks!");
    expect(htmlToPlainText("Line one<br>Line two")).toBe("Line one\nLine two");
  });

  it("unescapes entities rather than leaking them into the text part", () => {
    expect(htmlToPlainText("<p>Rates &lt; 50,000 &amp; up</p>")).toBe("Rates < 50,000 & up");
  });

  it("is empty for an editor holding nothing but an empty paragraph", () => {
    // What the Save button checks — an empty editor must not count as content.
    expect(htmlToPlainText("<p><br></p>")).toBe("");
    expect(htmlToPlainText("<br>")).toBe("");
  });

  it("drops an image, leaving the words around it", () => {
    expect(htmlToPlainText('<p>Trē <img src="cid:x"> Wellness</p>')).toBe("Trē  Wellness");
  });
});

describe("templateBodyPreview", () => {
  it("shows a rich template as readable text, not markup", () => {
    expect(templateBodyPreview("<p>Hi {name},</p><p>Thanks!</p>")).toBe("Hi {name},\nThanks!");
  });

  it("leaves a plain body exactly as typed", () => {
    // Including a literal angle bracket, which a sanitizer pass would eat.
    expect(templateBodyPreview("Rates < 50,000\nCall us")).toBe("Rates < 50,000\nCall us");
  });
});
