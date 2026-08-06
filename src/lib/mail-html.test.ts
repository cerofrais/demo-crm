import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml, extractCidImageIds } from "./mail-html";

describe("sanitizeEmailHtml", () => {
  it("keeps the formatting tags the compose toolbar can produce", () => {
    const html = "<p><b>Bold</b> <i>italic</i> <u>underline</u></p>";
    expect(sanitizeEmailHtml(html)).toBe(html);
  });

  it("keeps a safe link and marks it noopener/blank", () => {
    const out = sanitizeEmailHtml('<a href="https://example.com">click</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  it("keeps a cid: inline image reference", () => {
    const out = sanitizeEmailHtml('<img src="cid:abc-123" alt="x">');
    expect(out).toContain('src="cid:abc-123"');
  });

  it("strips a script tag entirely", () => {
    const out = sanitizeEmailHtml('<p>hi</p><script>alert(1)</script>');
    expect(out).not.toContain("script");
    expect(out).not.toContain("alert");
  });

  it("strips a javascript: link rather than passing it through", () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript:");
  });

  it("strips an inline event handler attribute", () => {
    const out = sanitizeEmailHtml('<img src="cid:abc" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
  });
});

describe("extractCidImageIds", () => {
  it("finds a single cid-referenced document id", () => {
    const html = '<p>hi</p><img src="cid:11111111-1111-1111-1111-111111111111">';
    expect(extractCidImageIds(html)).toEqual(["11111111-1111-1111-1111-111111111111"]);
  });

  it("de-duplicates the same id referenced twice", () => {
    const id = "22222222-2222-2222-2222-222222222222";
    const html = `<img src="cid:${id}"><img src="cid:${id}">`;
    expect(extractCidImageIds(html)).toEqual([id]);
  });

  it("returns an empty array for html with no inline images", () => {
    expect(extractCidImageIds("<p>just text</p>")).toEqual([]);
  });

  it("returns an empty array for null/undefined html", () => {
    expect(extractCidImageIds(null)).toEqual([]);
    expect(extractCidImageIds(undefined)).toEqual([]);
  });
});
