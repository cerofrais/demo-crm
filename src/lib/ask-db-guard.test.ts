import { describe, expect, it } from "vitest";
import { checkSql } from "./ask-db-guard";

/** Helper: the guard passed, and this is the SQL it would run. */
function pass(sql: string): string {
  const r = checkSql(sql);
  if (!r.ok) throw new Error(`expected pass, got: ${r.reason}`);
  return r.sql;
}

function reason(sql: string): string {
  const r = checkSql(sql);
  if (r.ok) throw new Error(`expected refusal, got SQL: ${r.sql}`);
  return r.reason;
}

describe("checkSql — what it lets through", () => {
  it("accepts an ordinary read", () => {
    expect(pass(`SELECT count(*) FROM "Enquiry" WHERE "createdAt" > now() - interval '7 days'`)).toContain("count(*)");
  });

  it("accepts a WITH query and does not mistake the CTE for a table", () => {
    const sql = pass(`WITH recent AS (SELECT id FROM "Message") SELECT count(*) FROM recent`);
    expect(sql).toContain("FROM recent");
  });

  it("strips the fences and the trailing semicolon a model adds", () => {
    expect(pass('```sql\nSELECT 1 FROM "Guest";\n```')).toBe('SELECT 1 FROM "Guest"');
  });

  it("quotes a table the model wrote bare — Postgres would fold it to a name that does not exist", () => {
    expect(pass("SELECT count(*) FROM message")).toBe('SELECT count(*) FROM "Message"');
    expect(pass("SELECT * FROM Enquiry e JOIN guest g ON g.id = e.\"guestId\"")).toBe(
      'SELECT * FROM "Enquiry" e JOIN "Guest" g ON g.id = e."guestId"',
    );
  });

  it("puts the quotes back on a bare camelCase column, which Postgres would fold to a name that does not exist", () => {
    // The real failure: `A.actorName` reached Postgres as `actorname`.
    expect(pass('SELECT a.actorName FROM "Activity" a')).toBe('SELECT a."actorName" FROM "Activity" a');
    expect(pass('SELECT createdAt FROM "Enquiry"')).toBe('SELECT "createdAt" FROM "Enquiry"');
  });

  it("leaves alone an alias the model invented, and anything already quoted", () => {
    const sql = pass('SELECT count(*) AS totalLeads, "createdAt" FROM "Enquiry" ORDER BY totalLeads DESC');
    expect(sql).toContain("AS totalLeads");
    expect(sql).toContain("ORDER BY totalLeads");
    expect(sql).toContain('"createdAt"');
  });

  it("keeps offsets right when a comment precedes the table name", () => {
    expect(pass('-- leads this week\nSELECT count(*) FROM enquiry')).toContain('FROM "Enquiry"');
  });

  it("reads a word like DROP inside a guest's message as text, not as a statement", () => {
    const sql = pass(`SELECT id FROM "Message" WHERE body ILIKE '%drop by tomorrow%'`);
    expect(sql).toContain("drop by tomorrow");
  });

  it('reads the "Call" table as a table, not as the CALL statement', () => {
    // The real regression: "how many calls lasted over five minutes" was
    // refused as `CALL is not allowed` before quoted identifiers were kept
    // out of the keyword scan.
    expect(pass(`SELECT count(*) FROM "Call" WHERE "durationSec" > 300`)).toContain('"Call"');
    expect(pass("SELECT count(*) FROM call WHERE \"durationSec\" > 300")).toContain('FROM "Call"');
    // …while the statement itself is still refused.
    expect(reason("CALL some_procedure()")).toMatch(/only select/i);
    expect(reason(`SELECT * FROM "Guest" UNION SELECT * FROM "Guest" WHERE call(1)`)).toMatch(/call/i);
  });

  it("does not mistake a camelCase column for its keyword", () => {
    // "deletedAt", "createdAt", "updatedAt" all contain a forbidden word.
    expect(pass(`SELECT "createdAt", "updatedAt" FROM "Enquiry" WHERE "deletedAt" IS NULL`)).toContain("deletedAt");
  });
});

describe("checkSql — what it refuses", () => {
  it("refuses anything that is not a SELECT", () => {
    expect(reason(`UPDATE "Enquiry" SET stage = 'lost'`)).toMatch(/only select/i);
    expect(reason(`DELETE FROM "Guest"`)).toMatch(/only select/i);
  });

  it("refuses a second statement smuggled in after the first", () => {
    expect(reason(`SELECT 1 FROM "Guest"; DROP TABLE "Guest"`)).toMatch(/one statement/i);
  });

  it("refuses a write hidden inside a CTE", () => {
    expect(reason(`WITH x AS (DELETE FROM "Guest" RETURNING id) SELECT * FROM x`)).toMatch(/delete/i);
  });

  it("refuses SELECT … INTO, which creates a table", () => {
    expect(reason(`SELECT * INTO copy_of_guests FROM "Guest"`)).toMatch(/into/i);
  });

  it("refuses health records, documents and WhatsApp credentials by table", () => {
    expect(reason(`SELECT * FROM "HealthProfile"`)).toMatch(/not available/i);
    expect(reason(`SELECT * FROM "Document"`)).toMatch(/not available/i);
    expect(reason(`SELECT * FROM "WhatsAppNumber"`)).toMatch(/not available/i);
  });

  it("refuses the catalog and anything else it does not know", () => {
    expect(reason(`SELECT * FROM pg_catalog.pg_tables`)).toMatch(/not available/i);
    expect(reason(`SELECT * FROM information_schema.columns`)).toMatch(/not available/i);
  });

  it("refuses a credential column even reached through an allowed table", () => {
    expect(reason(`SELECT n."metaAccessToken" FROM "Message" n`)).toMatch(/credential/i);
  });

  it("refuses functions that read files or hold the connection open", () => {
    expect(reason(`SELECT pg_read_file('/etc/passwd') FROM "Guest"`)).toMatch(/pg_read_file/i);
    expect(reason(`SELECT pg_sleep(60) FROM "Guest"`)).toMatch(/pg_sleep/i);
  });

  it("refuses dollar-quoted text, which exists here only to hide a keyword", () => {
    expect(reason(`SELECT $$ drop table "Guest" $$ FROM "Guest"`)).toMatch(/dollar-quoted/i);
  });

  it("refuses a query that reads no table at all", () => {
    expect(reason("SELECT 1")).toMatch(/no known table/i);
  });

  it("refuses an empty answer", () => {
    expect(reason("   ")).toMatch(/no sql/i);
  });
});

describe("checkSql — table aliases", () => {
  it("allows an alias spelled like a statement verb", () => {
    // `FROM "Call" call` is what a model writes without thinking, and the
    // alias used to trip the CALL-statement check: a perfectly good query was
    // refused, in production, as if it contained a CALL.
    expect(pass('SELECT count(*) FROM "Call" call WHERE call."durationSec" > 60')).toContain('FROM "Call" call');
    expect(pass('SELECT m.body FROM "Message" update WHERE update.channel = \'whatsapp\'')).toContain("FROM \"Message\" update");
  });

  it("still refuses the statement itself when it is not an alias", () => {
    expect(reason(`SELECT * FROM "Guest" g; CALL proc()`)).toMatch(/one statement/i);
    // Refused either as a write or for reading no table it knows — the CTE
    // is the only thing the SELECT reads, so both answers mean "no".
    expect(reason(`WITH x AS (UPDATE "Guest" SET city = 'x' RETURNING id) SELECT * FROM x`)).toMatch(
      /update|no known table/i,
    );
    expect(reason(`WITH x AS (UPDATE "Guest" u SET city = 'x' RETURNING id) SELECT * FROM "Guest" update`)).toMatch(
      /update|no known table/i,
    );
  });

  it("keeps quoting a bare table that carries an alias", () => {
    expect(pass("SELECT count(*) FROM call c WHERE c.status = 'completed'")).toContain('FROM "Call" c');
  });
});
