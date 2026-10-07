import { describe, it, expect } from "vitest";
import { cidToPreview, previewToCid, previewUrl } from "./editor-cid-preview";

const ID = "83231f38-5850-4c20-b883-0b802bc8602a";

/**
 * The footer logo showed as a broken image in the editor while sending fine:
 * browsers cannot load cid:. The editor shows a real preview and must convert
 * back exactly, or saving the footer would store a URL that no email can use.
 */
describe("editor cid preview", () => {
  it("shows a stored cid image through the file route", () => {
    const out = cidToPreview(`<p><img src="cid:${ID}" alt="trē" style="max-width:140px"></p>`);
    expect(out).toContain(`src="${previewUrl(ID)}"`);
    expect(out).toContain(`data-cid="${ID}"`);
    expect(out).not.toContain("cid:" + ID + '"');
  });

  it("round-trips back to exactly the stored form", () => {
    const stored = `<div>--</div><p><img src="cid:${ID}" alt="trē" style="max-width:140px"></p><p>text</p>`;
    expect(previewToCid(cidToPreview(stored))).toBe(stored);
  });

  it("survives the browser escaping & in the preview URL", () => {
    // innerHTML serialises the attribute with &amp;, which is what the editor
    // actually hands back on every keystroke.
    const fromBrowser = `<img src="/api/files/${ID}?inline=1&amp;preview=1" data-cid="${ID}" alt="x">`;
    expect(previewToCid(fromBrowser)).toBe(`<img src="cid:${ID}" alt="x">`);
  });

  it("handles attributes in any order and several images", () => {
    const other = "70d0173c-5924-46f8-a7a8-c3a098a52415";
    const html = `<img data-cid="${ID}" alt="a" src="/api/files/${ID}?inline=1&amp;preview=1"><img alt="b" src="/api/files/${other}?inline=1&amp;preview=1" data-cid="${other}">`;
    const out = previewToCid(html);
    expect(out).toContain(`src="cid:${ID}"`);
    expect(out).toContain(`src="cid:${other}"`);
    expect(out).not.toContain("data-cid");
  });

  it("leaves images that are not cid references alone", () => {
    const html = `<img src="https://trewellness.in/logo.png" alt="remote"><img src="data:image/png;base64,AAAA">`;
    expect(cidToPreview(html)).toBe(html);
    expect(previewToCid(html)).toBe(html);
  });

  it("does not double-convert an image already shown as a preview", () => {
    const once = cidToPreview(`<img src="cid:${ID}">`);
    expect(cidToPreview(once)).toBe(once);
  });

  it("leaves a cid that is not a document id alone", () => {
    const html = `<img src="cid:tre-footer-logo">`;
    expect(cidToPreview(html)).toBe(html);
  });
});
