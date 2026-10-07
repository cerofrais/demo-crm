import { describe, expect, it, beforeEach } from "vitest";
import { qrCooldownRemaining, resetQrAttempts, MAX_QR_ATTEMPTS, QR_COOLDOWN_MS } from "./whatsapp-admin";

// getQrCode itself talks to Evolution, so these cover the back-off state
// machine around it — the part that decides whether a request is made at all.
describe("QR pairing back-off", () => {
  const INSTANCE = "tre-test-instance";
  beforeEach(() => resetQrAttempts(INSTANCE));

  it("is not cooling down for an instance that has never asked", () => {
    expect(qrCooldownRemaining(INSTANCE)).toBe(0);
  });

  it("clears a cooldown on reset, so a genuine re-onboarding isn't blocked", () => {
    resetQrAttempts(INSTANCE);
    expect(qrCooldownRemaining(INSTANCE)).toBe(0);
  });

  it("uses a 3-attempt / 5-minute policy", () => {
    // Pinned because both numbers are a deliberate trade-off against how
    // WhatsApp scores repeated pairing attempts, not arbitrary tuning.
    expect(MAX_QR_ATTEMPTS).toBe(3);
    expect(QR_COOLDOWN_MS).toBe(5 * 60 * 1000);
  });
});
