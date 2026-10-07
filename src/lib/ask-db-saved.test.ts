import { describe, expect, it } from "vitest";
import { SAVED_ROWS, savedAnswerFrom, summariseLeadAnswer, summariseSqlAnswer } from "./ask-db-saved";

describe("summariseSqlAnswer", () => {
  it("keeps a readable slice of a big answer, and says it did", () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: i, name: `row ${i}` }));
    const saved = summariseSqlAnswer({ explanation: "Counts leads.", columns: ["id", "name"], rows, rowCount: 120 });

    expect(saved.rows).toHaveLength(SAVED_ROWS);
    expect(saved.rowCount).toBe(120);
    expect(saved.rowsTrimmed).toBe(true);
  });

  it("does not claim to have trimmed a small answer", () => {
    const saved = summariseSqlAnswer({ explanation: null, columns: ["count"], rows: [{ count: 3 }], rowCount: 1 });
    expect(saved.rowsTrimmed).toBe(false);
    expect(saved.rows).toEqual([{ count: 3 }]);
  });

  it("cuts a long cell rather than storing a whole message body in an audit row", () => {
    const saved = summariseSqlAnswer({
      explanation: null,
      columns: ["body"],
      rows: [{ body: "x".repeat(5000) }],
      rowCount: 1,
    });
    expect(String(saved.rows[0].body).length).toBeLessThan(400);
    expect(String(saved.rows[0].body).endsWith("…")).toBe(true);
  });

  it("keeps only the columns the answer had, so a stray key cannot ride along", () => {
    const saved = summariseSqlAnswer({
      explanation: null,
      columns: ["name"],
      rows: [{ name: "Seema", secret: "should not be kept" }],
      rowCount: 1,
    });
    expect(Object.keys(saved.rows[0])).toEqual(["name"]);
  });
});

describe("summariseLeadAnswer", () => {
  it("keeps the narrative with the evidence under it", () => {
    const saved = summariseLeadAnswer({
      answer: "She never replied [1].",
      lead: { enquiryId: "e1", name: "Seema Rani", stage: "contacted" },
      evidence: Array.from({ length: 20 }, (_, i) => ({
        n: i + 1,
        at: "2026-09-10, 12:00",
        kind: "message",
        who: "staff",
        detail: "d".repeat(1000),
      })),
    });

    expect(saved.answer).toContain("never replied");
    expect(saved.lead?.name).toBe("Seema Rani");
    expect(saved.evidence.length).toBeLessThanOrEqual(8);
    expect(saved.evidence[0].detail.length).toBeLessThan(400);
  });
});

describe("savedAnswerFrom", () => {
  it("reads back what was stored", () => {
    const sql = summariseSqlAnswer({ explanation: "x", columns: ["a"], rows: [{ a: 1 }], rowCount: 1 });
    expect(savedAnswerFrom({ saved: sql })).toMatchObject({ mode: "sql", rowCount: 1 });

    const lead = summariseLeadAnswer({ answer: "hi", lead: null, evidence: [] });
    expect(savedAnswerFrom({ saved: lead })).toMatchObject({ mode: "lead", answer: "hi" });
  });

  it("is null for the rows written before answers were kept", () => {
    // These still list as questions; they just cannot be re-opened, which the
    // page says rather than pretending it has an answer.
    expect(savedAnswerFrom({ question: "how many leads", sql: "SELECT 1" })).toBeNull();
    expect(savedAnswerFrom(null)).toBeNull();
    expect(savedAnswerFrom({ saved: { mode: "nonsense" } })).toBeNull();
  });
});
