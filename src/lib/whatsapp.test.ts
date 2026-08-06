import { describe, expect, it } from "vitest";
import { fromWhatsAppJid, toWhatsAppNumber } from "./whatsapp";

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
