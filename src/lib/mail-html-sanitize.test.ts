import { describe, it, expect } from "vitest";
import { sanitizeEmailHtml } from "./mail-html";

/**
 * What survives the email sanitizer decides what a guest actually receives.
 * Two lessons from the saved footer are pinned here: phone links were being
 * silently unlinked, and an image cannot be sized with CSS.
 */
describe("sanitizeEmailHtml", () => {
  it("keeps a tel: link, so a signature phone number can be tapped to call", () => {
    const out = sanitizeEmailHtml('<a href="tel:+918712623061">+91 87126 23061</a>');
    expect(out).toContain('href="tel:+918712623061"');
  });

  it("still keeps mailto and https links", () => {
    expect(sanitizeEmailHtml('<a href="mailto:hello@trewellness.in">x</a>')).toContain('href="mailto:hello@trewellness.in"');
    expect(sanitizeEmailHtml('<a href="https://www.trewellness.in">x</a>')).toContain('href="https://www.trewellness.in"');
  });

  it("still strips a javascript: link", () => {
    expect(sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:");
  });

  it("sizes an image by its width attribute, not CSS", () => {
    // style is stripped, so max-width never reaches the guest; width does —
    // and it is also the only sizing Outlook desktop honours.
    const out = sanitizeEmailHtml('<img src="cid:83231f38-5850-4c20-b883-0b802bc8602a" width="140" style="max-width:140px" alt="trē">');
    expect(out).toContain('width="140"');
    expect(out).not.toContain("style=");
  });
});
