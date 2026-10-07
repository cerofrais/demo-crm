import { describe, expect, it } from "vitest";
import {
  LEAD_ASSIGNMENT_CATEGORIES,
  SOURCE_ROUTED_CATEGORIES,
  isSourceRouted,
  normalizeOurNumber,
} from "./lead-assignment";

/**
 * The sources auto-assignment can see. Kept here rather than imported from the
 * Prisma LeadSource enum on purpose: this is the list a human maintains when a
 * new channel appears, and the tests below say which of them are configurable.
 */
const ALL_LEAD_SOURCES = [
  "website_form",
  "whatsapp",
  "instagram",
  "facebook",
  "referral",
  "walk_in",
  "phone",
  "email",
  "google_sheets",
  "other",
] as const;

describe("which lead sources can be restricted to chosen staff", () => {
  it("routes the channels that actually produce inbound leads", () => {
    // These are the ones an admin can narrow. website_form, instagram and
    // facebook used not to be: they fell through to the all-Sales default
    // pool, so leads kept reaching reps who had been deliberately left out
    // of every configured channel.
    for (const source of ["whatsapp", "email", "google_sheets", "website_form", "instagram", "facebook"]) {
      expect(isSourceRouted(source)).toBe(true);
    }
  });

  it("leaves manual-origin sources on the default pool", () => {
    // Nobody configures a walk-in; these are created by a human who already
    // knows the owner, so a channel rule would be meaningless.
    for (const source of ["referral", "walk_in", "phone", "other"]) {
      expect(isSourceRouted(source)).toBe(false);
    }
  });

  it("every source-routed category is a real lead source", () => {
    // A category whose name is not a source can never match, so it would sit
    // in the admin page collecting settings that silently do nothing.
    for (const category of SOURCE_ROUTED_CATEGORIES) {
      expect(ALL_LEAD_SOURCES).toContain(category);
    }
  });

  it("excludes call, which is routed by whoever answers the phone", () => {
    expect(LEAD_ASSIGNMENT_CATEGORIES).toContain("call");
    expect(SOURCE_ROUTED_CATEGORIES).not.toContain("call");
    expect(isSourceRouted("call")).toBe(false);
  });
});

describe("normalizeOurNumber", () => {
  it("normalises to E.164 with a leading + however it was entered", () => {
    expect(normalizeOurNumber("+918712623061")).toBe("+918712623061");
    expect(normalizeOurNumber("918712623061")).toBe("+918712623061");
    expect(normalizeOurNumber(" +91 87126 23061 ")).toBe("+918712623061");
    expect(normalizeOurNumber("+91-87126-23061")).toBe("+918712623061");
  });

  it("is null when there is no number, rather than matching everything", () => {
    // A rule keyed on "" would be looked up for every inbound message.
    expect(normalizeOurNumber(null)).toBeNull();
    expect(normalizeOurNumber(undefined)).toBeNull();
    expect(normalizeOurNumber("")).toBeNull();
    expect(normalizeOurNumber("+")).toBeNull();
  });

  it("matches a stored rule against the format the webhook reports", () => {
    // WhatsAppNumber.phoneNumber is "+9187...", an admin may paste "9187...".
    // Both have to land on the same key or the rule never fires.
    expect(normalizeOurNumber("918712623061")).toBe(normalizeOurNumber("+918712623061"));
  });
});
