import { describe, expect, it } from "vitest";
import { recentQuestions } from "./ask-db-history";

const row = (
  id: string,
  minutesAgo: number,
  output: unknown,
  opts: { success?: boolean; sub?: string; name?: string } = {},
) => ({
  id,
  createdAt: new Date(Date.parse("2026-10-01T06:00:00Z") - minutesAgo * 60_000),
  success: opts.success ?? true,
  output,
  triggeredBy: opts.sub ?? "harsha",
  triggeredByName: opts.name ?? "Harsha v",
});

describe("recentQuestions", () => {
  it("keeps the most recent telling of a question that was asked more than once", () => {
    const rows = [
      row("c", 1, { question: "how many leads last week", mode: "sql" }, { success: true }),
      row("b", 10, { question: "How Many Leads Last Week", mode: "sql" }, { success: false }),
      row("a", 20, { question: "how many leads last week", mode: "sql" }, { success: false }),
    ];

    const list = recentQuestions(rows, "harsha");

    expect(list).toHaveLength(1);
    // Newest row wins, so the entry says the question works now, not that it
    // failed the first two times someone was narrowing it down.
    expect(list[0].id).toBe("c");
    expect(list[0].ok).toBe(true);
  });

  it("marks who asked, and which are the reader's own", () => {
    const rows = [
      row("1", 1, { question: "mine", mode: "sql" }),
      row("2", 2, { question: "theirs", mode: "lead" }, { sub: "kruthika", name: "Kruthika Manager" }),
    ];

    const list = recentQuestions(rows, "harsha");

    expect(list[0]).toMatchObject({ question: "mine", mine: true, by: "Harsha v", mode: "sql" });
    expect(list[1]).toMatchObject({ question: "theirs", mine: false, by: "Kruthika Manager", mode: "lead" });
  });

  it("reads an older row that recorded the SQL but not the mode as a SQL question", () => {
    // The first deployed version wrote no `mode`; those rows are still history.
    const list = recentQuestions([row("1", 1, { question: "older one", sql: 'SELECT 1 FROM "Guest"' })], "harsha");
    expect(list[0].mode).toBe("sql");
  });

  it("skips a row that recorded no question at all", () => {
    const list = recentQuestions([row("1", 1, { sql: "SELECT 1" }), row("2", 2, { question: "   " }), row("3", 3, null)], "harsha");
    expect(list).toEqual([]);
  });

  it("formats the time in IST and honours the limit", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(String(i), i, { question: `q${i}`, mode: "sql" }));

    const list = recentQuestions(rows, "harsha", 5);

    expect(list).toHaveLength(5);
    // 06:00 UTC is 11:30 IST.
    expect(list[0].at).toBe("01 Oct, 11:30");
  });
});
