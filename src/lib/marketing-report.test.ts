import { describe, expect, it } from "vitest";
import {
  REPORT_HEADERS,
  classifyTemperature,
  detailedRemarks,
  istDayBounds,
  parseCampaignParts,
  parseIntake,
  toCsv,
  tagFilenameSuffix,
} from "./marketing-report";

const DAY = 86_400_000;
const NOW = new Date("2026-08-10T06:00:00.000Z");

function temp(over: Partial<Parameters<typeof classifyTemperature>[0]> = {}) {
  return classifyTemperature({
    stage: "contacted",
    lostReason: null,
    inboundCount: 0,
    lastInboundAt: null,
    remarks: [],
    now: NOW,
    ...over,
  });
}

describe("parseIntake", () => {
  // The exact shape the n8n Meta Lead Ads integration writes.
  const REAL = [
    "Biggest health challenge: stress_&_fatigue",
    "Wellness focus: experience_",
    "What brings them to India: I'm from hyderabad",
    "When they want to visit: Yes",
    "Ad: CG_Trewellness_FBIG_NRI-Lead_Hyderabad-PostalCode_28July2026_Ad2_Video",
    "Form: CG_Trewellness_FBIG_NRI-Lead_Hyderabad-PostalCode_23June2026",
    "Submitted: 2026-08-10T00:14:23-05:00",
  ].join("\n");

  it("pulls the form, ad and submitted lines out of a real payload", () => {
    const p = parseIntake(REAL);
    expect(p.formName).toBe("CG_Trewellness_FBIG_NRI-Lead_Hyderabad-PostalCode_23June2026");
    expect(p.adName).toBe("CG_Trewellness_FBIG_NRI-Lead_Hyderabad-PostalCode_28July2026_Ad2_Video");
    expect(p.submittedAt).toBe("2026-08-10T00:14:23-05:00");
  });

  it("keeps the form questions as answers, and only those", () => {
    const p = parseIntake(REAL);
    expect(p.answers).toHaveLength(4);
    expect(p.answers[0]).toBe("Biggest health challenge: stress_&_fatigue");
    expect(p.answers.join(" ")).not.toContain("Submitted:");
  });

  it("keeps an answer whose value itself contains a colon", () => {
    const p = parseIntake("When they want to visit: after 5:30 pm");
    expect(p.answers[0]).toBe("When they want to visit: after 5:30 pm");
  });

  it("treats free text from a hand-entered lead as an answer rather than dropping it", () => {
    const p = parseIntake("Walked in asking about detox");
    expect(p.formName).toBeNull();
    expect(p.answers).toEqual(["Walked in asking about detox"]);
  });

  it("is safe on empty/missing intake", () => {
    for (const v of [null, undefined, "", "   "]) {
      const p = parseIntake(v);
      expect(p.answers).toEqual([]);
      expect(p.formName).toBeNull();
    }
  });
});

describe("parseCampaignParts", () => {
  const CAMPAIGN = "CG_Trewellness_FBIG_SeasonalDetox-Lead_AP&Telangna_26May2026";

  it("reads platform, adset and creative from the agency's naming", () => {
    const p = parseCampaignParts(CAMPAIGN, `${CAMPAIGN}_Remarket_Ad1_Video`);
    expect(p.platform).toBe("Meta (Facebook / Instagram)");
    expect(p.adset).toBe("Remarket");
    expect(p.creative).toBe("Ad1_Video");
  });

  it("handles an ad with no adset segment", () => {
    const p = parseCampaignParts(CAMPAIGN, `${CAMPAIGN}_Ad1_Static`);
    expect(p.creative).toBe("Ad1_Static");
    expect(p.adset).toBeNull();
  });

  it("falls back to the lead source when the name carries no platform token", () => {
    const p = parseCampaignParts("Seasonal detox", null, "walk_in");
    expect(p.platform).toBe("walk in");
    expect(p.creative).toBeNull();
  });

  it("does not mistake a longer token for a platform", () => {
    // "FBX" must not match the FB rule.
    const p = parseCampaignParts("CG_FBX_Thing", null, null);
    expect(p.platform).toBeNull();
  });

  it("returns nulls rather than throwing on empty input", () => {
    expect(parseCampaignParts(null, null)).toEqual({ platform: null, adset: null, creative: null });
  });
});

describe("classifyTemperature — management's definitions", () => {
  it("Hot: the guest replied and the conversation is live", () => {
    expect(temp({ inboundCount: 2, lastInboundAt: new Date(NOW.getTime() - 2 * DAY) })).toBe("Hot");
  });

  it("Hot: a won lead is never shown as cooling", () => {
    expect(temp({ stage: "booking_confirmed" })).toBe("Hot");
    expect(temp({ stage: "converted" })).toBe("Hot");
  });

  it("Warm: replied once but the thread has gone quiet", () => {
    expect(temp({ inboundCount: 1, lastInboundAt: new Date(NOW.getTime() - 20 * DAY) })).toBe("Warm");
  });

  it("Warm: asked us to call back or come later", () => {
    expect(
      temp({
        inboundCount: 1,
        lastInboundAt: new Date(NOW.getTime() - 30 * DAY),
        remarks: ["Asked to call back next month"],
      }),
    ).toBe("Warm");
  });

  it("Cold: never responded at all", () => {
    expect(temp({ inboundCount: 0 })).toBe("Cold");
  });

  it("Cold: an explicit no outranks an active conversation", () => {
    // A guest who chatted yesterday but said the price is too high is not Hot.
    expect(
      temp({
        inboundCount: 4,
        lastInboundAt: new Date(NOW.getTime() - 1 * DAY),
        remarks: ["Says price is too high, not interested"],
      }),
    ).toBe("Cold");
  });

  it("Cold: price objection recorded as the lost reason", () => {
    expect(temp({ inboundCount: 2, lastInboundAt: NOW, lostReason: "Too expensive" })).toBe("Cold");
  });

  it("Dead: formally closed out", () => {
    // Kept distinct from Cold so "Cold" still means "gone quiet".
    expect(temp({ stage: "lost", inboundCount: 3, lastInboundAt: NOW })).toBe("Dead");
  });

  it("is deterministic — same input, same answer", () => {
    const input = {
      stage: "qualified",
      lostReason: null,
      inboundCount: 1,
      lastInboundAt: new Date(NOW.getTime() - 3 * DAY),
      remarks: ["interested"],
      now: NOW,
    };
    expect(classifyTemperature(input)).toBe(classifyTemperature(input));
  });
});

describe("detailedRemarks", () => {
  it("uses management's vocabulary", () => {
    expect(detailedRemarks("doctor_consultation", "", 1)).toContain("Consultation Booked");
    expect(detailedRemarks("contacted", "customer says too expensive", 1)).toContain("Price Concern");
    expect(detailedRemarks("contacted", "wants a call back tomorrow", 1)).toContain("Callback Requested");
    expect(detailedRemarks("contacted", "comparing with another centre", 1)).toContain("Comparing Options");
    expect(detailedRemarks("contacted", "wrong number", 1)).toContain("Invalid Number");
  });

  it("can report more than one signal", () => {
    const out = detailedRemarks("contacted", "interested but price is too high, will call back", 1);
    expect(out).toContain("Price Concern");
    expect(out).toContain("Callback Requested");
  });

  it("says No Response rather than leaving the cell blank", () => {
    // A blank cell reads as "nobody has looked at this yet".
    expect(detailedRemarks("new_lead", "", 0)).toBe("No Response");
  });
});

describe("toCsv", () => {
  it("quotes every cell and doubles embedded quotes", () => {
    const csv = toCsv(["A", "B"], [['say "hi"', "plain"]]);
    expect(csv).toContain('"say ""hi"""');
  });

  it("keeps a comma or newline inside a cell from splitting the row", () => {
    const csv = toCsv(["A"], [["one, two\nthree"]]);
    const body = csv.split("\r\n")[1];
    expect(body).toBe('"one, two\nthree"');
  });

  it("starts with a BOM so Excel reads UTF-8 names correctly", () => {
    expect(toCsv(["A"], [["Trē"]]).charCodeAt(0)).toBe(0xfeff);
  });

  it("emits a header even with no rows", () => {
    expect(toCsv(REPORT_HEADERS, []).split("\r\n")).toHaveLength(1);
  });
});

describe("istDayBounds", () => {
  it("covers exactly one IST day", () => {
    const { from, to } = istDayBounds(new Date("2026-08-10T09:00:00.000Z"));
    expect(to.getTime() - from.getTime()).toBe(DAY);
    // 00:00 IST is 18:30 UTC the previous day.
    expect(from.toISOString()).toBe("2026-08-09T18:30:00.000Z");
  });

  it("keeps a late-evening IST timestamp in that same IST day", () => {
    // 18:00 UTC on the 10th is 23:30 IST on the 10th — still the 10th, whose
    // IST day started at 18:30 UTC on the 9th.
    const { from } = istDayBounds(new Date("2026-08-10T18:00:00.000Z"));
    expect(from.toISOString()).toBe("2026-08-09T18:30:00.000Z");
  });

  it("rolls over at IST midnight, not UTC midnight", () => {
    // 18:35 UTC on the 10th is 00:05 IST on the 11th — the next report day.
    // Getting this wrong would file a lead received just after midnight into
    // the previous day's report.
    const { from } = istDayBounds(new Date("2026-08-10T18:35:00.000Z"));
    expect(from.toISOString()).toBe("2026-08-10T18:30:00.000Z");
  });
});

describe("REPORT_HEADERS", () => {
  it("covers every field management asked for", () => {
    for (const required of [
      "Lead ID",
      "Lead Received Date & Time",
      "Mobile Number",
      "City/Location",
      "Form Name",
      "Campaign Name",
      "Platform",
      "Adset / Ad Group",
      "Ad / Creative",
      "Assigned Sales Representative",
      "First Follow-up Date & Time",
      "Latest Follow-up Date & Time",
      "Number of Follow-up Attempts",
      "Current Lead Status",
      "Detailed Remarks",
      "Next Follow-up Date",
      "Final Conversion Status",
    ]) {
      expect(REPORT_HEADERS).toContain(required);
    }
  });

  it("has no duplicate column names", () => {
    expect(REPORT_HEADERS.length).toBe(new Set(REPORT_HEADERS).size);
  });
});

describe("tagFilenameSuffix", () => {
  it("adds nothing when the report isn't filtered", () => {
    expect(tagFilenameSuffix([])).toBe("");
  });

  it("names the tags so downloads stay tellable apart", () => {
    expect(tagFilenameSuffix(["mini-detox"])).toBe("-mini-detox");
    expect(tagFilenameSuffix(["mini-detox", "revisit"])).toBe("-mini-detox_revisit");
  });

  it("strips the colon from namespaced system tags", () => {
    // Windows refuses a filename containing ":" and these are emailed as
    // attachments, so "source:instagram" must not reach the filename intact.
    expect(tagFilenameSuffix(["source:instagram"])).toBe("-source-instagram");
    expect(tagFilenameSuffix(["age:25-40", "revisit"])).toBe("-age-25-40_revisit");
    expect(tagFilenameSuffix(["source:instagram"])).not.toContain(":");
  });

  it("caps at three and counts the rest", () => {
    // Campaign slugs are long; six of them would produce a filename no mail
    // client shows in full.
    expect(tagFilenameSuffix(["a", "b", "c", "d", "e"])).toBe("-a_b_c_plus2");
  });
});
