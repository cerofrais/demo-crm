import { beforeEach, describe, expect, it, vi } from "vitest";
import { askDatabase, SYSTEM_NARRATE, SYSTEM_ROUTE } from "./ask-db";
import { QueryFailed } from "@/lib/ask-db-run";
import type { LeadCard } from "@/lib/ask-db-lead";

const chatJSON = vi.fn();
const runReadOnlyQuery = vi.fn();
const logAiDecision = vi.fn();
const findLeadCandidates = vi.fn();
const buildLeadDossier = vi.fn();

vi.mock("./provider", () => ({ chatJSON: (...a: unknown[]) => chatJSON(...a) }));
vi.mock("./audit", () => ({ logAiDecision: (...a: unknown[]) => logAiDecision(...a) }));
vi.mock("@/lib/ask-db-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ask-db-run")>()),
  runReadOnlyQuery: (...a: unknown[]) => runReadOnlyQuery(...a),
}));
vi.mock("@/lib/ask-db-lead", () => ({
  findLeadCandidates: (...a: unknown[]) => findLeadCandidates(...a),
  buildLeadDossier: (...a: unknown[]) => buildLeadDossier(...a),
}));
vi.mock("./config", () => ({
  aiFeatureEnabled: () => true,
  aiConfig: () => ({ provider: "ollama", model: "gemma4:latest" }),
}));

const RESULT = { columns: ["count"], rows: [{ count: 3 }], rowCount: 1, truncated: false, durationMs: 12 };
const WHO = { triggeredBy: "sub-1", triggeredByName: "Harsha" };

const LEAD: LeadCard = {
  enquiryId: "11111111-1111-4111-8111-111111111111",
  guestId: "g1",
  name: "Seema Rani",
  phone: "+919876543210",
  city: "Hyderabad",
  stage: "contacted",
  source: "instagram",
  owner: "Prasanna Sales",
  campaignLabel: "Seasonal Detox Campaign HYD",
  tags: ["hyd"],
  createdAt: "2026-09-01, 10:00",
  lastActivityAt: "2026-09-10, 12:00",
  deleted: false,
};

/** The model's replies, chosen by which system prompt it was called with. */
let routeReply: unknown = { mode: "sql" };
let narrateReply: unknown = { answer: "She was messaged twice and never replied. [1]", evidence: [1] };
let sqlReplies: unknown[] = [];

const isRouter = (system: unknown) => String(system) === SYSTEM_ROUTE;
const isNarrator = (system: unknown) => String(system) === SYSTEM_NARRATE;
/** Calls that actually asked for SQL, i.e. excluding the router. */
const sqlCalls = () => chatJSON.mock.calls.filter((c) => !isRouter(c[0]) && !isNarrator(c[0]));

beforeEach(() => {
  chatJSON.mockReset();
  runReadOnlyQuery.mockReset();
  logAiDecision.mockReset();
  findLeadCandidates.mockReset();
  buildLeadDossier.mockReset();
  routeReply = { mode: "sql" };
  narrateReply = { answer: "She was messaged twice and never replied." };
  sqlReplies = [];
  chatJSON.mockImplementation(async (system: unknown) => {
    if (isRouter(system)) return routeReply;
    if (isNarrator(system)) return narrateReply;
    return sqlReplies.shift() ?? { sql: "", explanation: "nothing to ask" };
  });
});

describe("askDatabase — questions about the business", () => {
  it("answers a question and records what it ran", async () => {
    sqlReplies = [{ sql: 'SELECT count(*) FROM "Enquiry"', explanation: "Counts leads." }];
    runReadOnlyQuery.mockResolvedValue(RESULT);

    const answer = await askDatabase({ question: "how many leads", ...WHO });

    expect(answer.ok && answer.mode).toBe("sql");
    if (!answer.ok || answer.mode !== "sql") return;
    expect(answer.result.rows).toEqual([{ count: 3 }]);
    expect(answer.attempts).toBe(1);
    expect(logAiDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "db_question",
        success: true,
        triggeredBy: "sub-1",
        output: expect.objectContaining({ sql: 'SELECT count(*) FROM "Enquiry"', rowCount: 1 }),
      }),
    );
  });

  it("feeds a Postgres error back to the model once, and succeeds on the corrected query", async () => {
    sqlReplies = [
      { sql: 'SELECT actorName FROM "Activity"', explanation: "first try" },
      { sql: 'SELECT "actorName" FROM "Activity"', explanation: "corrected" },
    ];
    runReadOnlyQuery
      .mockRejectedValueOnce(new QueryFailed('column "actorname" does not exist'))
      .mockResolvedValueOnce(RESULT);

    const answer = await askDatabase({ question: "who did what", ...WHO });

    expect(answer.ok).toBe(true);
    if (!answer.ok || answer.mode !== "sql") return;
    expect(answer.attempts).toBe(2);
    // The second prompt carries the failure, which is the whole point of it.
    expect(String(sqlCalls()[1][1])).toContain('column "actorname" does not exist');
  });

  it("gives up after the second failure rather than looping on the GPU", async () => {
    sqlReplies = [
      { sql: 'SELECT nope FROM "Enquiry"', explanation: "…" },
      { sql: 'SELECT nope FROM "Enquiry"', explanation: "…" },
    ];
    runReadOnlyQuery.mockRejectedValue(new QueryFailed('column "nope" does not exist'));

    const answer = await askDatabase({ question: "something odd", ...WHO });

    expect(answer.ok).toBe(false);
    if (answer.ok || answer.mode !== "sql") return;
    expect(answer.error).toContain("does not exist");
    expect(sqlCalls()).toHaveLength(2);
    expect(logAiDecision).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it("never runs SQL the guard refused", async () => {
    sqlReplies = [
      { sql: 'DELETE FROM "Guest"', explanation: "wiping" },
      { sql: 'DELETE FROM "Guest"', explanation: "wiping" },
    ];

    const answer = await askDatabase({ question: "delete the junk leads", ...WHO });

    expect(answer.ok).toBe(false);
    if (answer.ok || answer.mode !== "sql") return;
    expect(answer.error).toMatch(/only select/i);
    expect(runReadOnlyQuery).not.toHaveBeenCalled();
  });

  it("passes on the model's own refusal without inventing a query", async () => {
    sqlReplies = [{ sql: "", explanation: "Health records are not readable here." }];

    const answer = await askDatabase({ question: "show me medical conditions", ...WHO });

    expect(answer.ok).toBe(false);
    if (answer.ok || answer.mode !== "sql") return;
    expect(answer.sql).toBeNull();
    expect(answer.error).toContain("Health records");
    expect(runReadOnlyQuery).not.toHaveBeenCalled();
  });

  it("runs an admin's hand-edited SQL without asking the model, but still through the guard", async () => {
    runReadOnlyQuery.mockResolvedValue(RESULT);

    const answer = await askDatabase({ question: "edited", sql: 'SELECT count(*) FROM "Guest"', ...WHO });

    expect(answer.ok).toBe(true);
    expect(chatJSON).not.toHaveBeenCalled();
    expect(runReadOnlyQuery).toHaveBeenCalledWith('SELECT count(*) FROM "Guest"');

    const refused = await askDatabase({ question: "edited", sql: 'DROP TABLE "Guest"', ...WHO });
    expect(refused.ok).toBe(false);
    expect(runReadOnlyQuery).toHaveBeenCalledTimes(1);
  });
});

describe("askDatabase — questions about one lead", () => {
  const TIMELINE = [
    { ts: Date.parse("2026-09-10T06:30:00Z"), at: "2026-09-10, 12:00", kind: "message" as const, who: "staff", detail: "whatsapp outbound: are you still interested?" },
    { ts: Date.parse("2026-09-02T05:00:00Z"), at: "2026-09-02, 10:30", kind: "call" as const, who: "Prasanna Sales", detail: "outbound call, no_answer, 0 min" },
    { ts: Date.parse("2026-09-01T04:30:00Z"), at: "2026-09-01, 10:00", kind: "stage" as const, who: "Prasanna Sales", detail: "moved new_lead → contacted" },
  ];
  const DOSSIER = { lead: LEAD, timeline: TIMELINE, prompt: "LEAD: Seema Rani\nTIMELINE…" };

  it("narrates the lead's own timeline instead of writing SQL", async () => {
    routeReply = { mode: "lead", name: "Seema Rani" };
    findLeadCandidates.mockResolvedValue([LEAD]);
    buildLeadDossier.mockResolvedValue(DOSSIER);

    const answer = await askDatabase({ question: "what is happening with Seema Rani, why is she in contacted?", ...WHO });

    expect(answer.ok && answer.mode).toBe("lead");
    if (!answer.ok || answer.mode !== "lead") return;
    expect(answer.answer).toContain("never replied");
    expect(answer.lead.name).toBe("Seema Rani");
    expect(answer.timeline).toHaveLength(3);
    expect(runReadOnlyQuery).not.toHaveBeenCalled();
    expect(sqlCalls()).toHaveLength(0);
    expect(logAiDecision).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "db_question", enquiryId: LEAD.enquiryId, success: true }),
    );
  });

  it("proves the answer with the entries it cited, taken from the database rather than the model", async () => {
    routeReply = { mode: "lead", name: "Seema Rani" };
    narrateReply = {
      answer: "She was called and never picked up [2], and the follow-up went unanswered [1].",
      // The model may also cite text of its own; only the NUMBERS are used.
      evidence: [2, 1],
    };
    findLeadCandidates.mockResolvedValue([LEAD]);
    buildLeadDossier.mockResolvedValue(DOSSIER);

    const answer = await askDatabase({ question: "why is she stuck?", ...WHO });

    expect(answer.ok && answer.mode).toBe("lead");
    if (!answer.ok || answer.mode !== "lead") return;
    // Oldest first, so the proof reads as the sequence of events.
    expect(answer.evidence.map((e) => e.n)).toEqual([2, 1]);
    expect(answer.evidence[0].detail).toBe(TIMELINE[1].detail);
    expect(answer.evidence[1].detail).toBe(TIMELINE[0].detail);
  });

  it("drops a citation that points at no entry, and never shows an empty proof", async () => {
    routeReply = { mode: "lead", name: "Seema Rani" };
    narrateReply = { answer: "Something happened [99].", evidence: [99, 0, -3, 1, 1] };
    findLeadCandidates.mockResolvedValue([LEAD]);
    buildLeadDossier.mockResolvedValue(DOSSIER);

    const first = await askDatabase({ question: "why is she stuck?", ...WHO });
    if (!first.ok || first.mode !== "lead") throw new Error("expected a lead answer");
    expect(first.evidence.map((e) => e.n)).toEqual([1]);

    // An answer that cited nothing still gets something to check it against.
    narrateReply = { answer: "No citations at all.", evidence: [] };
    const second = await askDatabase({ question: "why is she stuck?", ...WHO });
    if (!second.ok || second.mode !== "lead") throw new Error("expected a lead answer");
    expect(second.evidence).toHaveLength(3);
  });

  it("asks which lead when the name matches more than one", async () => {
    routeReply = { mode: "lead", name: "Seema" };
    findLeadCandidates.mockResolvedValue([LEAD, { ...LEAD, enquiryId: "22222222-2222-4222-8222-222222222222", stage: "lost" }]);

    const answer = await askDatabase({ question: "what happened with Seema", ...WHO });

    expect(answer.ok).toBe(false);
    if (answer.ok || answer.mode !== "choose") return;
    expect(answer.candidates).toHaveLength(2);
    expect(answer.error).toMatch(/more than one/i);
    expect(buildLeadDossier).not.toHaveBeenCalled();
  });

  it("says so plainly when no lead matches the name", async () => {
    routeReply = { mode: "lead", name: "Nobody At All" };
    findLeadCandidates.mockResolvedValue([]);

    const answer = await askDatabase({ question: "what happened with Nobody At All", ...WHO });

    expect(answer.ok).toBe(false);
    if (answer.ok || answer.mode !== "choose") return;
    expect(answer.error).toMatch(/no lead matches/i);
    expect(answer.candidates).toEqual([]);
  });

  it("answers about the lead the admin picked, skipping the name lookup", async () => {
    buildLeadDossier.mockResolvedValue(DOSSIER);

    const answer = await askDatabase({ question: "why is she stuck?", enquiryId: LEAD.enquiryId, ...WHO });

    expect(answer.ok && answer.mode).toBe("lead");
    expect(findLeadCandidates).not.toHaveBeenCalled();
    expect(chatJSON).toHaveBeenCalledTimes(1); // the narration only — no router
  });

  it("still shows the timeline when the model fails to narrate it", async () => {
    routeReply = { mode: "lead", name: "Seema Rani" };
    findLeadCandidates.mockResolvedValue([LEAD]);
    buildLeadDossier.mockResolvedValue(DOSSIER);
    chatJSON.mockImplementation(async (system: unknown) => {
      if (isRouter(system)) return routeReply;
      throw new Error("model timed out");
    });

    const answer = await askDatabase({ question: "what is happening with Seema Rani", ...WHO });

    expect(answer.ok && answer.mode).toBe("lead");
    if (!answer.ok || answer.mode !== "lead") return;
    expect(answer.answer).toContain("model timed out");
    expect(answer.timeline).toHaveLength(3);
    expect(answer.evidence.length).toBeGreaterThan(0);
  });

  it("falls back to SQL when the router itself fails", async () => {
    sqlReplies = [{ sql: 'SELECT count(*) FROM "Enquiry"', explanation: "Counts leads." }];
    runReadOnlyQuery.mockResolvedValue(RESULT);
    chatJSON.mockImplementation(async (system: unknown) => {
      if (isRouter(system)) throw new Error("router unavailable");
      return sqlReplies.shift();
    });

    const answer = await askDatabase({ question: "how many leads", ...WHO });

    expect(answer.ok && answer.mode).toBe("sql");
  });
});
