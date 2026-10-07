import { describe, it, expect } from "vitest";
import {
  contactNameFor,
  describeMetaMessage,
  metaMediaOf,
  metaMessageBody,
  metaValues,
  toE164,
  type MetaWebhookBody,
} from "./whatsapp-cloud-inbound";

describe("metaValues", () => {
  it("flattens every entry and change, not just the first", () => {
    const body: MetaWebhookBody = {
      entry: [
        { changes: [{ value: { messages: [{ id: "a" }] } }, { value: { messages: [{ id: "b" }] } }] },
        { changes: [{ value: { statuses: [{ id: "c", status: "read" }] } }] },
      ],
    };
    const values = metaValues(body);
    expect(values).toHaveLength(3);
    expect(values.flatMap((v) => v.messages ?? []).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("falls back to an unwrapped value object", () => {
    expect(metaValues({ messages: [{ id: "x" }] })[0].messages?.[0].id).toBe("x");
  });

  it("returns nothing for an empty or unrelated payload", () => {
    expect(metaValues({})).toEqual([]);
    expect(metaValues({ entry: [] })).toEqual([]);
  });
});

describe("toE164", () => {
  it("adds the plus Meta omits", () => {
    expect(toE164("918978451689")).toBe("+918978451689");
  });
});

describe("contactNameFor", () => {
  const value = { contacts: [{ wa_id: "918978451689", profile: { name: " Abilash " } }] };

  it("matches the profile name by wa_id", () => {
    expect(contactNameFor(value, "918978451689")).toBe("Abilash");
  });

  it("is null for a different sender or a missing id", () => {
    expect(contactNameFor(value, "910000000000")).toBeNull();
    expect(contactNameFor(value, undefined)).toBeNull();
  });
});

describe("metaMediaOf", () => {
  it("keeps a document's own filename and caption", () => {
    const media = metaMediaOf({
      type: "document",
      document: { id: "m1", mime_type: "application/pdf", filename: "report.pdf", caption: "here" },
    });
    expect(media).toMatchObject({
      kind: "document",
      mediaId: "m1",
      mimeType: "application/pdf",
      fileName: "report.pdf",
      caption: "here",
    });
  });

  it("invents a filename with the right extension when Meta gives none", () => {
    const media = metaMediaOf({ type: "image", image: { id: "m2", mime_type: "image/png" } }, 1700);
    expect(media?.fileName).toBe("photo-1700.png");
  });

  it("strips codec parameters off the mime type", () => {
    // Voice notes arrive as `audio/ogg; codecs=opus`, which is not a usable
    // key for the extension table nor a clean value to store.
    const media = metaMediaOf({ type: "audio", audio: { id: "m3", mime_type: "audio/ogg; codecs=opus" } }, 1700);
    expect(media?.mimeType).toBe("audio/ogg");
    expect(media?.fileName).toBe("voice-1700.ogg");
  });

  it("is null for a text message", () => {
    expect(metaMediaOf({ type: "text", text: { body: "hi" } })).toBeNull();
  });

  it("ignores a media object with no id — there is nothing to download", () => {
    expect(metaMediaOf({ type: "image", image: { mime_type: "image/jpeg" } })).toBeNull();
  });
});

describe("describeMetaMessage", () => {
  it("returns the text body verbatim", () => {
    expect(describeMetaMessage({ type: "text", text: { body: "hello" } })).toBe("hello");
  });

  it("labels a reaction and its removal", () => {
    expect(describeMetaMessage({ type: "reaction", reaction: { emoji: "👍" } })).toBe("Reacted 👍");
    expect(describeMetaMessage({ type: "reaction", reaction: { emoji: "" } })).toBe("Removed a reaction");
  });

  it("labels a location with its name and coordinates", () => {
    expect(
      describeMetaMessage({ type: "location", location: { latitude: 17.385, longitude: 78.4867, name: "Trē" } }),
    ).toBe("📍 Location: Trē (17.38500, 78.48670)");
  });

  it("counts shared contacts", () => {
    expect(describeMetaMessage({ type: "contacts", contacts: [{}, {}] })).toBe("👤 Shared 2 contacts");
    expect(
      describeMetaMessage({ type: "contacts", contacts: [{ profile: { name: "Ravi" } }] }),
    ).toBe("👤 Shared contact: Ravi");
  });

  it("uses the button/list title a guest actually tapped", () => {
    expect(
      describeMetaMessage({ type: "interactive", interactive: { button_reply: { title: "Yes, book me" } } }),
    ).toBe("Yes, book me");
    expect(describeMetaMessage({ type: "button", button: { text: "Stop promotions" } })).toBe("Stop promotions");
  });

  it("names why Meta could not process an unsupported message", () => {
    expect(
      describeMetaMessage({ type: "unsupported", errors: [{ code: 131051, title: "Message type unknown" }] }),
    ).toBe("[Unsupported message: Message type unknown]");
  });

  it("returns null for something genuinely unrecognised", () => {
    expect(describeMetaMessage({ type: "future_type" })).toBeNull();
  });
});

describe("metaMessageBody", () => {
  it("prefers a media caption over the type label", () => {
    const msg = { type: "image", image: { id: "m", mime_type: "image/jpeg", caption: "my reports" } };
    expect(metaMessageBody(msg, metaMediaOf(msg))).toBe("my reports");
  });

  it("falls back to the media type label", () => {
    const msg = { type: "image", image: { id: "m", mime_type: "image/jpeg" } };
    expect(metaMessageBody(msg, metaMediaOf(msg))).toBe("📷 Photo");
  });

  it("never stores an empty body", () => {
    expect(metaMessageBody({ type: "future_type" }, null)).toBe("[Unsupported message type]");
  });
});
