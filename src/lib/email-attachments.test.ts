import { describe, it, expect } from "vitest";
import { realAttachmentNames } from "./email-attachments";

describe("realAttachmentNames", () => {
  it("keeps what the sender attached", () => {
    expect(
      realAttachmentNames([
        { filename: "lab-report.pdf", contentType: "application/pdf", contentDisposition: "attachment" },
        { filename: "passport.jpg", contentType: "image/jpeg", contentDisposition: "attachment" },
      ]),
    ).toEqual(["lab-report.pdf", "passport.jpg"]);
  });

  it("ignores images the body shows in place, like a signature logo", () => {
    // Counting these would put a paperclip on almost every email with a logo.
    expect(
      realAttachmentNames([
        { filename: "logo.png", contentType: "image/png", contentDisposition: "inline", cid: "logo@x", related: true },
        { filename: "icon.png", contentType: "image/png", contentDisposition: "inline", cid: "icon@x" },
      ]),
    ).toEqual([]);
  });

  it("keeps an inline-disposed file that nothing in the body references", () => {
    // Some clients mark ordinary attachments inline; with no cid it is not
    // shown in the body, so it is an attachment.
    expect(realAttachmentNames([{ filename: "brochure.pdf", contentDisposition: "inline" }])).toEqual(["brochure.pdf"]);
  });

  it("names an attachment that arrived without a filename", () => {
    expect(realAttachmentNames([{ contentType: "application/pdf", contentDisposition: "attachment" }])).toEqual([
      "attachment.pdf",
    ]);
    expect(realAttachmentNames([{ contentDisposition: "attachment" }])).toEqual(["attachment"]);
  });

  it("returns nothing for an email with no parts", () => {
    expect(realAttachmentNames(undefined)).toEqual([]);
    expect(realAttachmentNames([])).toEqual([]);
  });
});
