import { describe, expect, it } from "vitest";
import {
  addDays,
  addWeeks,
  buildTouches,
  dayRangeBounds,
  isYmd,
  rangeDays,
  callContact,
  CSV_HEADERS,
  csvRows,
  DEFAULT_CRESENT_TAGS,
  groupByDay,
  isWeekStart,
  istWeekStart,
  matchingTags,
  messageContact,
  renderReportHtml,
  weekBounds,
  adminCommentsCell,
  leadFolder,
  recordingFileName,
  recordingPaths,
  reportRecordings,
  safeSegment,
  touchCells,
  TOUCH_HEADERS,
  type CresentLeadDTO,
} from "./cresent-report-shape";

const at = (iso: string) => new Date(iso);

describe("weeks (Monday–Sunday, IST)", () => {
  it("puts Sunday 11pm IST in the week that started the Monday before", () => {
    // 2026-09-13 is a Sunday; 23:00 IST is 17:30 UTC.
    expect(istWeekStart(at("2026-09-13T17:30:00Z"))).toBe("2026-09-07");
  });

  it("puts Monday 00:30 IST — still Sunday in UTC — in the new week", () => {
    expect(istWeekStart(at("2026-09-13T19:00:00Z"))).toBe("2026-09-14");
  });

  it("bounds a week from Monday 00:00 IST to the next Monday", () => {
    const { from, to } = weekBounds("2026-09-07");
    expect(from.toISOString()).toBe("2026-09-06T18:30:00.000Z");
    expect(to.toISOString()).toBe("2026-09-13T18:30:00.000Z");
  });

  it("steps and validates week starts", () => {
    expect(addWeeks("2026-09-07", -1)).toBe("2026-08-31");
    expect(isWeekStart("2026-09-07")).toBe(true);
    expect(isWeekStart("2026-09-08")).toBe(false);
    expect(isWeekStart("2026-02-30")).toBe(false);
  });
});

describe("custom ranges", () => {
  it("covers whole IST days, both ends included", () => {
    const { from, to } = dayRangeBounds("2026-09-01", "2026-09-03");
    expect(from.toISOString()).toBe("2026-08-31T18:30:00.000Z");
    expect(to.toISOString()).toBe("2026-09-03T18:30:00.000Z");
    expect(rangeDays("2026-09-01", "2026-09-03")).toBe(3);
    expect(rangeDays("2026-09-05", "2026-09-05")).toBe(1);
  });

  it("validates and steps plain dates", () => {
    expect(isYmd("2026-09-16")).toBe(true);
    expect(isYmd("2026-02-30")).toBe(false);
    expect(isYmd("16-09-2026")).toBe(false);
    expect(addDays("2026-08-31", 6)).toBe("2026-09-06");
  });
});

describe("matchingTags — ANY selected tag gets the lead in", () => {
  it("keeps a lead carrying just one of the selected tags", () => {
    expect(matchingTags(["source:instagram", "foreign"], ["foreign", "sample-itinerary-ep"])).toEqual(["foreign"]);
  });
  it("drops a lead with none of them", () => {
    expect(matchingTags(["source:instagram"], ["foreign"])).toEqual([]);
  });
});

const call = (iso: string, status: string, durationSec = 0, notes: string | null = null) =>
  callContact({ startedAt: at(iso), direction: "outbound", status, durationSec, notes });
const wa = (iso: string, status = "delivered") => messageContact({ at: at(iso), channel: "whatsapp", status });

describe("buildTouches", () => {
  it("orders contacts and keeps the first four — primary and three follow-ups", () => {
    const t = buildTouches(
      [
        wa("2026-09-08T10:00:00Z"),
        call("2026-09-08T05:00:00Z", "no_answer"),
        call("2026-09-09T05:00:00Z", "completed", 125),
        call("2026-09-10T05:00:00Z", "completed", 30),
        call("2026-09-11T05:00:00Z", "voicemail"),
      ],
      [],
    );
    expect(t.map((x) => x.status)).toEqual([
      "Call — Not answered",
      "WhatsApp — Delivered",
      "Call — Connected (2m 05s)",
      "Call — Connected (0m 30s)",
    ]);
  });

  it("folds a burst of WhatsApp messages into one contact", () => {
    const t = buildTouches([wa("2026-09-08T10:00:00Z", "read"), wa("2026-09-08T10:01:00Z"), wa("2026-09-08T10:40:00Z")], []);
    expect(t).toHaveLength(1);
    expect(t[0].status).toBe("WhatsApp — Read · 3 messages");
  });

  it("folds quick redials and reports the best outcome", () => {
    const t = buildTouches([call("2026-09-08T10:00:00Z", "no_answer"), call("2026-09-08T10:05:00Z", "completed", 61)], []);
    expect(t).toEqual([expect.objectContaining({ status: "Call — Connected (1m 01s) · 2 calls" })]);
  });

  it("starts a new contact on a different channel, however close", () => {
    const t = buildTouches([call("2026-09-08T10:00:00Z", "no_answer"), wa("2026-09-08T10:02:00Z")], []);
    expect(t).toHaveLength(2);
  });

  it("starts a new contact on the same channel after an hour", () => {
    expect(buildTouches([wa("2026-09-08T10:00:00Z"), wa("2026-09-08T11:30:00Z")], [])).toHaveLength(2);
  });

  it("gives each contact the remarks written after it and before the next", () => {
    const t = buildTouches(
      [call("2026-09-08T10:00:00Z", "completed", 90), call("2026-09-09T10:00:00Z", "no_answer")],
      [
        { at: at("2026-09-08T09:00:00Z"), text: "before any call — not a remark on one" },
        { at: at("2026-09-08T10:05:00Z"), text: "Interested, wants pricing" },
        { at: at("2026-09-09T10:10:00Z"), text: "RNR" },
      ],
    );
    expect(t[0].remarks).toBe("Interested, wants pricing");
    expect(t[1].remarks).toBe("RNR");
  });

  it("leaves remarks empty when the rep wrote none", () => {
    expect(buildTouches([call("2026-09-08T10:00:00Z", "no_answer")], [])[0].remarks).toBe("");
  });

  it("includes a note typed on the call itself", () => {
    expect(buildTouches([call("2026-09-08T10:00:00Z", "completed", 40, "Call back Friday")], [])[0].remarks).toBe("Call back Friday");
  });

  it("labels an incoming call", () => {
    const c = callContact({ startedAt: at("2026-09-08T10:00:00Z"), direction: "inbound", status: "completed", durationSec: 0 });
    expect(buildTouches([c], [])[0].status).toBe("Call — Connected (incoming)");
  });
});

const lead = (id: string, receivedAt: string, touches = 0): CresentLeadDTO => ({
  enquiryId: id,
  receivedAt,
  tags: ["foreign"],
  name: `Guest ${id}`,
  phone: "+1 555",
  email: "",
  city: "",
  touches: Array.from({ length: touches }, (_, i) => ({
    at: `2026-09-${String(8 + i).padStart(2, "0")}T05:00:00.000Z`,
    channel: "call" as const,
    status: "Call — Not answered",
    remarks: i === 0 ? "RNR <b>" : "",
  })),
  stage: "rnr",
});

describe("layout", () => {
  const report = {
    rangeStart: "2026-09-07",
    rangeEnd: "2026-09-13",
    tags: ["foreign"],
    leadCount: 3,
    generatedAt: "",
    // Tuesday 00:30 IST belongs to Tuesday even though it is Monday in UTC.
    days: groupByDay([lead("b", "2026-09-07T19:00:00Z"), lead("a", "2026-09-07T04:00:00Z", 4), lead("c", "2026-09-07T06:00:00Z")]),
  };

  it("groups leads by the IST day they arrived", () => {
    expect(report.days.map((d) => [d.day, d.leads.map((l) => l.enquiryId)])).toEqual([
      ["2026-09-07", ["a", "c"]],
      ["2026-09-08", ["b"]],
    ]);
  });

  it("writes Date and count on a day's first CSV row only", () => {
    const rows = csvRows(report, (t) => t);
    expect(rows[0].slice(0, 3)).toEqual(["7 September", "2", "foreign"]);
    expect(rows[1].slice(0, 2)).toEqual(["", ""]);
    expect(rows[2].slice(0, 2)).toEqual(["8 September", "1"]);
    expect(rows.every((r) => r.length === CSV_HEADERS.length)).toBe(true);
  });

  it("puts Created At between City and the contacts, a Call Recording after each contact, then Final Stage and Admin Comments", () => {
    expect(CSV_HEADERS.slice(6, 9)).toEqual(["City", "Created At", "Primary Communication Date"]);
    expect(CSV_HEADERS.slice(8, 12)).toEqual([
      "Primary Communication Date",
      "Primary Communication Remarks",
      "Primary Communication Status",
      "Primary Communication Call Recording",
    ]);
    expect(CSV_HEADERS.slice(-6)).toEqual([
      "Follow Up 3 Date",
      "Follow Up 3 Remarks",
      "Follow Up 3 Status",
      "Follow Up 3 Call Recording",
      "Final Stage",
      "Admin Comments",
    ]);
    expect(CSV_HEADERS).toHaveLength(3 + 4 + 1 + 4 * 4 + 1 + 1);

    const row = csvRows(report, (t) => t)[0];
    expect(row[7]).toBe("7 Sept, 9:30 am"); // lead "a" arrived 04:00 UTC
    expect(row.slice(20, 24)).toEqual(["11 Sept, 10:30 am", "", "Call — Not answered", ""]); // follow-up 3
    expect(row[24]).toBe("RNR / Follow-up");
    expect(row[25]).toBe("");
  });

  it("spans the day cells in the emailed table and escapes remarks", () => {
    const html = renderReportHtml(report, (t) => t);
    expect(html).toContain('rowspan="2" align="center"');
    expect(html).toContain('colspan="4"');
    expect(html).toContain("RNR &lt;b&gt;");
    expect(html).toContain(">Created At<");
    expect(html).toContain(">Follow Up 3 Remarks<");
    expect(html).toContain(">Final Stage<");
    expect(html).toContain(">RNR / Follow-up<");
  });
});

describe("default tags", () => {
  it("are the campaign tags the n8n campaign labels actually produce", async () => {
    const { slugifyTag } = await import("./lead-tags");
    const campaign = (label: string) => `campaign:${slugifyTag(label)}`;
    expect(DEFAULT_CRESENT_TAGS).toEqual([
      campaign("NRI Lead Campaign"),
      campaign("Seasonal Detox Campaign AP/TEL"),
      campaign("Seasonal Detox Campaign HYD"),
      campaign("Seasonal Detox"),
    ]);
  });
});

describe("parseRangeParams", () => {
  const now = new Date("2026-09-16T06:00:00Z"); // Wednesday
  it("defaults to last week", async () => {
    const { parseRangeParams } = await import("./cresent-range");
    expect(parseRangeParams({}, now)).toEqual({ start: "2026-09-07", end: "2026-09-13" });
  });
  it("takes a week or a custom range", async () => {
    const { parseRangeParams } = await import("./cresent-range");
    expect(parseRangeParams({ week: "2026-08-31" }, now)).toEqual({ start: "2026-08-31", end: "2026-09-06" });
    expect(parseRangeParams({ week: "2026-09-03" }, now)).toHaveProperty("error");
    expect(parseRangeParams({ from: "2026-09-02", to: "2026-09-09" }, now)).toEqual({ start: "2026-09-02", end: "2026-09-09" });
  });
  it("rejects half, backwards, or overlong ranges", async () => {
    const { parseRangeParams } = await import("./cresent-range");
    expect(parseRangeParams({ from: "2026-09-02" }, now)).toHaveProperty("error");
    expect(parseRangeParams({ from: "2026-09-09", to: "2026-09-02" }, now)).toHaveProperty("error");
    expect(parseRangeParams({ from: "2026-01-01", to: "2026-09-01" }, now)).toHaveProperty("error");
  });
});

describe("call recordings", () => {
  const at = (iso: string) => new Date(iso);

  it("names a file by its IST time, direction and outcome", () => {
    // 09:02 UTC is 14:32 IST.
    expect(recordingFileName({ startedAt: at("2026-09-18T09:02:00Z"), direction: "outbound", status: "completed" })).toBe(
      "2026-09-18_14-32_outgoing_connected.mp3",
    );
    expect(recordingFileName({ startedAt: at("2026-09-18T09:02:00Z"), direction: "inbound", status: "no_answer" })).toBe(
      "2026-09-18_14-32_incoming_no-answer.mp3",
    );
  });

  it("lays paths out campaign / lead / file, and keeps same-minute calls apart", () => {
    const paths = recordingPaths("Seasonal Detox Campaign HYD", { name: "Priya Sharma", phone: "+91 98765 43210" }, [
      { id: "b", startedAt: at("2026-09-18T09:02:40Z"), direction: "outbound", status: "completed" },
      { id: "a", startedAt: at("2026-09-18T09:02:05Z"), direction: "outbound", status: "completed" },
    ]);
    expect(paths.get("a")).toBe(
      "Seasonal Detox Campaign HYD/Priya Sharma (+919876543210)/2026-09-18_14-32_outgoing_connected.mp3",
    );
    expect(paths.get("b")).toBe(
      "Seasonal Detox Campaign HYD/Priya Sharma (+919876543210)/2026-09-18_14-32_outgoing_connected-2.mp3",
    );
  });

  it("makes names safe as folders on every OS", () => {
    expect(safeSegment('A/B\\C: "x"?*<>|', "fallback")).toBe("A B C x");
    expect(safeSegment("Dr. K. ", "fallback")).toBe("Dr. K");
    expect(safeSegment("   ", "fallback")).toBe("fallback");
    expect(leadFolder("", "")).toBe("Unnamed lead");
    expect(leadFolder("Ravi", "")).toBe("Ravi");
  });

  it("carries recordings on the call touch they belong to, redials included", () => {
    const touches = buildTouches(
      [
        callContact({
          startedAt: at("2026-09-18T09:00:00Z"),
          direction: "outbound",
          status: "no_answer",
          durationSec: 0,
          recording: { callId: "c1", path: "X/Y/one.mp3" },
        }),
        // A redial ten minutes later folds into the same contact.
        callContact({
          startedAt: at("2026-09-18T09:10:00Z"),
          direction: "outbound",
          status: "completed",
          durationSec: 95,
          recording: { callId: "c2", path: "X/Y/two.mp3" },
        }),
        messageContact({ at: at("2026-09-18T11:00:00Z"), channel: "whatsapp", status: "read" }),
      ],
      [],
    );
    expect(touches[0].recordings).toEqual([
      { callId: "c1", path: "X/Y/one.mp3" },
      { callId: "c2", path: "X/Y/two.mp3" },
    ]);
    expect(touches[1].recordings).toBeUndefined();
  });

  it("prints the paths in the CSV cell only, never on screen", () => {
    const lead = {
      enquiryId: "e1",
      receivedAt: "2026-09-18T04:00:00Z",
      tags: [],
      name: "Priya",
      phone: "",
      email: "",
      city: "",
      stage: "contacted" as const,
      touches: [
        {
          at: "2026-09-18T09:00:00Z",
          channel: "call" as const,
          status: "Call — Connected",
          remarks: "",
          recordings: [
            { callId: "c1", path: "X/Y/one.mp3" },
            { callId: "c2", path: "X/Y/two.mp3" },
          ],
        },
      ],
    };
    expect(touchCells(lead)).toHaveLength(TOUCH_HEADERS.length);
    expect(touchCells(lead, { withRecordings: true })[3]).toBe("X/Y/one.mp3\nX/Y/two.mp3");

    const report = {
      rangeStart: "2026-09-14",
      rangeEnd: "2026-09-20",
      tags: [],
      leadCount: 1,
      generatedAt: "",
      days: [{ day: "2026-09-18", leads: [lead, { ...lead, enquiryId: "e2" }] }],
    };
    // Listed once each, even when two rows point at the same call.
    expect(reportRecordings(report).map((r) => r.callId)).toEqual(["c1", "c2"]);
  });
});

describe("admin comments", () => {
  it("are written with their time and author, oldest first", () => {
    const cell = adminCommentsCell({
      adminComments: [
        { at: "2026-09-18T04:45:00Z", text: "Call back after Diwali", author: "Harsha" },
        { at: "2026-09-19T05:00:00Z", text: "  VIP  ", author: null },
      ],
    } as CresentLeadDTO);
    expect(cell).toBe("18 Sept, 10:15 am — Harsha: Call back after Diwali\n19 Sept, 10:30 am — VIP");
  });

  it("is an empty cell for a lead without any", () => {
    expect(adminCommentsCell({} as CresentLeadDTO)).toBe("");
  });
});
