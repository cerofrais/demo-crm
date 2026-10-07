import { describe, it, expect } from "vitest";
import { subjectKey } from "./health-ingest";

/**
 * These cover the identity rule only — the part that decides whether two
 * screening forms are about the same person. Getting it wrong in either
 * direction is a real harm: too loose merges siblings' medical histories
 * (the bug this replaced), too strict buries a genuine repeat submission.
 */
describe("subjectKey", () => {
  it("treats the same name and phone as the same person", () => {
    expect(subjectKey("Nikki Siddi", "+919848369909")).toBe(
      subjectKey("Nikki Siddi", "+919848369909"),
    );
  });

  it("ignores case and stray whitespace in the name", () => {
    expect(subjectKey("  nikki   SIDDI ", "+919848369909")).toBe(
      subjectKey("Nikki Siddi", "+919848369909"),
    );
  });

  it("separates different people who share a phone", () => {
    // The actual reported case: three Siddis, one number. Keying on phone
    // alone is exactly what blended their records together.
    const phone = "+919848369909";
    const keys = new Set([
      subjectKey("Nikki Siddi", phone),
      subjectKey("Akki Siddi", phone),
      subjectKey("Sunitha Siddi", phone),
    ]);
    expect(keys.size).toBe(3);
  });

  it("separates the same name on different phones", () => {
    expect(subjectKey("Nikki Siddi", "+919848369909")).not.toBe(
      subjectKey("Nikki Siddi", "+918639946509"),
    );
  });

  it("does not collide a missing name with a missing phone", () => {
    // Both are empty on one side but the separator keeps them distinct, so a
    // nameless record can't be matched against a phoneless one.
    expect(subjectKey(null, "+919848369909")).not.toBe(subjectKey("+919848369909", null));
  });

  it("is stable for null and undefined", () => {
    expect(subjectKey(null, null)).toBe(subjectKey(undefined, undefined));
  });
});
