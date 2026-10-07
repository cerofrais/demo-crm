import { describe, expect, it } from "vitest";
import { ALLOWED_TABLES, KNOWN_COLUMNS, SAMPLE_QUESTIONS, schemaPrompt } from "./ask-db-catalog";
import { checkSql } from "./ask-db-guard";

describe("the schema shown to the model matches the schema it is allowed to read", () => {
  it("shows the model every table it is allowed to read", () => {
    // A readable table the prompt never mentions is a table nobody can query.
    for (const name of ALLOWED_TABLES) expect(schemaPrompt()).toContain(`"${name}"`);
  });

  it("knows the camelCase columns the guard has to re-quote", () => {
    expect(KNOWN_COLUMNS.get("createdat")).toBe("createdAt");
    expect(KNOWN_COLUMNS.get("actorname")).toBe("actorName");
    expect(KNOWN_COLUMNS.get("fromemail")).toBe("fromEmail");
    // Lower-case columns need no repair and must stay out of the map, or the
    // guard would start quoting ordinary words.
    expect(KNOWN_COLUMNS.has("body")).toBe(false);
    expect(KNOWN_COLUMNS.has("status")).toBe(false);
  });

  it("names no table the guard would refuse", () => {
    const prompt = schemaPrompt();
    for (const name of ["HealthProfile", "Document", "WhatsAppNumber"]) {
      expect(prompt).not.toContain(`"${name}"`);
    }
  });

  it("tells the model the things it cannot guess from column names", () => {
    const prompt = schemaPrompt();
    expect(prompt).toContain("Asia/Kolkata"); // UTC storage, IST office
    expect(prompt).toContain("+918712623061"); // "the 61 number"
    // Soft deletes, AND which tables actually have the column: the model
    // applied "deletedAt" IS NULL to "Call" and "Activity", which have no
    // such column, and Postgres rejected the query.
    expect(prompt).toContain('ONLY these four tables have a "deletedAt" column');
    expect(prompt).toContain("externalRef"); // how lead-ad/sheet leads are identified
    // source='google_sheets' has never been used in production; steering the
    // model onto it answered "0 leads" to a question with a real answer.
    expect(prompt).toContain("do NOT filter on it");
    expect(prompt).toContain("NOT ONE ROW in the database has it");
    // Staff tags are on the LEAD; Guest.tags is machine-written. Asked for
    // "guests with the tag detox", the model filtered Guest.tags — which holds
    // no such tag — and answered zero twice.
    expect(prompt).toContain("TAGS LIVE IN TWO PLACES");
    expect(prompt).toContain("'detox' = ANY(e.tags)");
  });
});

describe("the sample questions on the page", () => {
  it("are questions, not instructions", () => {
    for (const q of SAMPLE_QUESTIONS) expect(q).toMatch(/\?$|^Show /i);
  });

  it("the hand-written SQL behind the headline example passes the guard", () => {
    // The question in the brief: "messages sent from the 61 number in the last
    // 10 days" — this is the shape the schema prompt steers the model towards.
    const r = checkSql(`
      SELECT "createdAt", "toEmail", body
      FROM "Message"
      WHERE channel = 'whatsapp' AND direction = 'outbound'
        AND "fromEmail" = '+918712623061'
        AND "createdAt" >= now() - interval '10 days'
        AND "deletedAt" IS NULL
      ORDER BY "createdAt" DESC
    `);
    expect(r.ok).toBe(true);
  });
});
