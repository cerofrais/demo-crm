import { describe, expect, it } from "vitest";
import { isShadowActivity, sortTimelineNewestFirst, type TimelineRow } from "./ask-db-lead";

const row = (ts: string, at: string, detail: string): TimelineRow => ({
  ts: new Date(ts).getTime(),
  at,
  kind: "event",
  who: "someone",
  detail,
});

describe("sortTimelineNewestFirst", () => {
  it("orders by the real instant, not by how the time is written", () => {
    // The bug this exists for: sorting the formatted strings put "1:24 a.m."
    // after "8:18 a.m." on the same day, so the model was handed a story in
    // the wrong order and narrated it that way.
    const rows = [
      row("2026-09-25T02:48:00Z", "2026-09-25, 8:18 a.m.", "morning"),
      row("2026-09-24T19:54:00Z", "2026-09-25, 1:24 a.m.", "just after midnight"),
      row("2026-09-25T05:23:00Z", "2026-09-25, 10:53 a.m.", "later morning"),
    ];

    expect(sortTimelineNewestFirst(rows).map((r) => r.detail)).toEqual([
      "later morning",
      "morning",
      "just after midnight",
    ]);
  });

  it("leaves the caller's array alone", () => {
    const rows = [row("2026-09-01T00:00:00Z", "a", "first"), row("2026-09-02T00:00:00Z", "b", "second")];
    sortTimelineNewestFirst(rows);
    expect(rows.map((r) => r.detail)).toEqual(["first", "second"]);
  });
});

describe("isShadowActivity", () => {
  it("drops the activity stubs that duplicate a note or a message", () => {
    // These carry no text of their own; the Note and Message rows do. A cited
    // stub rendered as an empty proof block on the page.
    expect(isShadowActivity("note")).toBe(true);
    expect(isShadowActivity("message_sent")).toBe(true);
    expect(isShadowActivity("message_received")).toBe(true);
  });

  it("keeps the events that exist nowhere else", () => {
    for (const kind of ["stage_change", "assign", "created", "consent", "task_created", "doc_upload"]) {
      expect(isShadowActivity(kind)).toBe(false);
    }
  });
});
