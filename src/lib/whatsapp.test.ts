import { describe, expect, it } from "vitest";
import {
  describeNonMediaMessage,
  fromWhatsAppJid,
  quotedMessageId,
  toWhatsAppNumber,
} from "./whatsapp";

describe("quotedMessageId", () => {
  it("reads Evolution's normalised shape (top-level contextInfo)", () => {
    // Exactly the payload Evolution stores for a text reply.
    expect(
      quotedMessageId({
        contextInfo: { stanzaId: "wamid.HBgMOTE5MDAwMjA2NjMzFQIAERgSMEYwRTE4NkY4OEE4QzI2RUU1AA==" },
        conversation: "Enquire Now",
      }),
    ).toBe("wamid.HBgMOTE5MDAwMjA2NjMzFQIAERgSMEYwRTE4NkY4OEE4QzI2RUU1AA==");
  });

  it("reads Baileys' nested shape on a text reply", () => {
    expect(
      quotedMessageId({ extendedTextMessage: { text: "yes", contextInfo: { stanzaId: "ABC123" } } }),
    ).toBe("ABC123");
  });

  it("finds the quote on a media reply too", () => {
    expect(
      quotedMessageId({ imageMessage: { mimetype: "image/jpeg", contextInfo: { stanzaId: "IMG9" } } }),
    ).toBe("IMG9");
  });

  it("returns null for an ordinary message and for a blank stanzaId", () => {
    expect(quotedMessageId({ conversation: "hello" })).toBeNull();
    expect(quotedMessageId({ contextInfo: { stanzaId: "  " } })).toBeNull();
    expect(quotedMessageId({})).toBeNull();
  });
});

describe("describeNonMediaMessage", () => {
  it("labels a reaction with its emoji", () => {
    expect(describeNonMediaMessage({ reactionMessage: { text: "👍" } })).toBe("Reacted 👍");
  });

  it("treats an empty reaction body as a removal", () => {
    expect(describeNonMediaMessage({ reactionMessage: { text: "" } })).toBe("Removed a reaction");
  });

  it("labels a location with its name and coordinates", () => {
    expect(
      describeNonMediaMessage({
        locationMessage: { degreesLatitude: 17.385, degreesLongitude: 78.4867, name: "Trē Wellness" },
      }),
    ).toBe("📍 Location: Trē Wellness (17.38500, 78.48670)");
  });

  it("labels shared contacts, singular and plural", () => {
    expect(describeNonMediaMessage({ contactMessage: { displayName: "Ravi" } })).toBe(
      "👤 Shared contact: Ravi",
    );
    expect(
      describeNonMediaMessage({ contactsArrayMessage: { contacts: [{}, {}, {}] } }),
    ).toBe("👤 Shared 3 contacts");
  });

  it("labels albums, polls and orders", () => {
    expect(
      describeNonMediaMessage({ albumMessage: { expectedImageCount: 3, expectedVideoCount: 1 } }),
    ).toBe("🖼️ Album (4 items)");
    expect(describeNonMediaMessage({ pollCreationMessage: { name: "Which date?" } })).toBe(
      "📊 Poll: Which date?",
    );
    expect(describeNonMediaMessage({ orderMessage: { itemCount: 2 } })).toBe("🛒 Order (2 items)");
    // Singular must not read "1 items".
    expect(describeNonMediaMessage({ orderMessage: { itemCount: 1 } })).toBe("🛒 Order (1 item)");
  });

  it("surfaces the text a button/list reply actually selected", () => {
    expect(
      describeNonMediaMessage({ templateButtonReplyMessage: { selectedDisplayText: "Enquire Now" } }),
    ).toBe("Enquire Now");
    expect(describeNonMediaMessage({ listResponseMessage: { title: "7-day detox" } })).toBe(
      "7-day detox",
    );
  });

  it("says so plainly when WhatsApp couldn't decrypt the message", () => {
    expect(describeNonMediaMessage({ secretEncryptedMessage: {} })).toBe(
      "[Encrypted message — not readable]",
    );
  });

  it("returns null for plain text and for genuinely unknown types, so the caller keeps its fallback", () => {
    expect(describeNonMediaMessage({ conversation: "hi" })).toBeNull();
    expect(describeNonMediaMessage({})).toBeNull();
  });
});

describe("fromWhatsAppJid", () => {
  it("converts a plain WhatsApp JID to E.164", () => {
    expect(fromWhatsAppJid("919876543210@s.whatsapp.net")).toBe("+919876543210");
  });

  it("strips any non-digit characters before the @ before re-adding the +", () => {
    expect(fromWhatsAppJid("+91-9876-543210@s.whatsapp.net")).toBe("+919876543210");
  });
});

describe("toWhatsAppNumber", () => {
  it("strips the leading + from an E.164 number", () => {
    expect(toWhatsAppNumber("+919876543210")).toBe("919876543210");
  });

  it("is the inverse of fromWhatsAppJid for a plain JID", () => {
    const jid = "919876543210@s.whatsapp.net";
    expect(toWhatsAppNumber(fromWhatsAppJid(jid))).toBe("919876543210");
  });

  it("leaves a number with no leading + unchanged", () => {
    expect(toWhatsAppNumber("919876543210")).toBe("919876543210");
  });
});
