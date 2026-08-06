import { describe, expect, it } from "vitest";
import { buildStorageKey, isAllowedUploadType, isInlineType, maxUploadBytes } from "./storage";

describe("isAllowedUploadType (F46 MIME allowlist)", () => {
  it("allows a PDF for every category", () => {
    for (const category of ["medical", "consent", "operational", "marketing"]) {
      expect(isAllowedUploadType(category, "application/pdf")).toBe(true);
    }
  });

  it("rejects SVG everywhere (F24 stored-XSS)", () => {
    expect(isAllowedUploadType("operational", "image/svg+xml")).toBe(false);
    expect(isAllowedUploadType("marketing", "image/svg+xml")).toBe(false);
  });

  it("only medical/consent are restricted to imagery + PDF, not office docs", () => {
    expect(
      isAllowedUploadType(
        "medical",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(false);
    expect(
      isAllowedUploadType(
        "operational",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(true);
  });

  it("returns false for an unknown category", () => {
    expect(isAllowedUploadType("not-a-real-category", "application/pdf")).toBe(false);
  });

  it("allows a recorded voice note's real MIME type, codec parameter and all", () => {
    // MediaRecorder's own .mimeType (AudioRecordButton, WhatsApp panel +
    // remarks composer) always includes a codec param — comparing that raw
    // string against the allowlist's bare "audio/webm" made every recorded
    // voice note upload 415, even though "audio/webm" itself was allowed.
    expect(isAllowedUploadType("operational", "audio/webm;codecs=opus")).toBe(true);
    expect(isAllowedUploadType("operational", "audio/webm")).toBe(true);
  });
});

describe("maxUploadBytes (F39 size caps)", () => {
  it("caps medical/consent uploads at 25MB", () => {
    expect(maxUploadBytes("medical")).toBe(25 * 1024 * 1024);
    expect(maxUploadBytes("consent")).toBe(25 * 1024 * 1024);
  });

  it("caps operational/marketing uploads at 50MB", () => {
    expect(maxUploadBytes("operational")).toBe(50 * 1024 * 1024);
  });

  it("falls back to the 25MB default for an unknown category", () => {
    expect(maxUploadBytes("not-a-real-category")).toBe(25 * 1024 * 1024);
  });
});

describe("isInlineType (F24 inline-preview safety)", () => {
  it("allows PDFs and raster images inline", () => {
    expect(isInlineType("application/pdf")).toBe(true);
    expect(isInlineType("image/png")).toBe(true);
    expect(isInlineType("image/jpeg")).toBe(true);
  });

  it("never allows SVG or HTML inline, even though browsers can render them", () => {
    expect(isInlineType("image/svg+xml")).toBe(false);
    expect(isInlineType("text/html")).toBe(false);
  });

  it("allows the WhatsApp voice-note/video MIME types added for the WhatsApp tab", () => {
    expect(isInlineType("audio/ogg")).toBe(true);
    expect(isInlineType("video/mp4")).toBe(true);
  });

  it("allows a recorded voice note's real MIME type, codec parameter and all", () => {
    expect(isInlineType("audio/webm;codecs=opus")).toBe(true);
  });
});

describe("buildStorageKey", () => {
  it("scopes the key under guests/<id> when a guestId is given", () => {
    const key = buildStorageKey({ category: "operational", filename: "report.pdf", guestId: "g1" });
    expect(key.startsWith("operational/guests/g1/")).toBe(true);
  });

  it("prefers guestId over enquiryId when both are present", () => {
    const key = buildStorageKey({
      category: "operational",
      filename: "report.pdf",
      guestId: "g1",
      enquiryId: "e1",
    });
    expect(key.startsWith("operational/guests/g1/")).toBe(true);
  });

  it("falls back to enquiries/<id> when only enquiryId is given", () => {
    const key = buildStorageKey({ category: "operational", filename: "report.pdf", enquiryId: "e1" });
    expect(key.startsWith("operational/enquiries/e1/")).toBe(true);
  });

  it("falls back to general/ when neither id is given", () => {
    const key = buildStorageKey({ category: "operational", filename: "report.pdf" });
    expect(key.startsWith("operational/general/")).toBe(true);
  });

  it("sanitizes unsafe filename characters", () => {
    const key = buildStorageKey({ category: "operational", filename: "my report (final)?.pdf" });
    expect(key).not.toMatch(/[()? ]/);
  });

  it("produces a different key on every call (collision-free)", () => {
    const a = buildStorageKey({ category: "operational", filename: "report.pdf", guestId: "g1" });
    const b = buildStorageKey({ category: "operational", filename: "report.pdf", guestId: "g1" });
    expect(a).not.toBe(b);
  });
});
