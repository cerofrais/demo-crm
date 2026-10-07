import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildPushPayload,
  canonicalCampaign,
  isDue,
  isInCrm,
  parseLeadRows,
  phoneKey,
  selectLeadsToCheck,
  type SheetLead,
} from "./sheet-check-parse";
import { buildJwtAssertion, parseSheetUrl } from "./google-sheets";

const HEADER = [
  "id", "created_time", "ad_id", "ad_name", "adset_id", "adset_name", "campaign_id", "campaign_name",
  "form_id", "form_name", "is_organic", "platform", "_what_is_your_biggest_health_challenge_today?",
  "choose_your_wellness_focus", "full_name", "phone_number", "email", "city", "lead_status",
  "Primary communication", "Handled by",
];
const row = (n: number, extra: Partial<Record<string, string>> = {}) => {
  const base: Record<string, string> = {
    id: `l:10000000000000${n}`,
    created_time: `2026-08-2${n % 10}T10:00:00-05:00`,
    ad_id: "ag:1", ad_name: "CG_Trewellness_FBIG_NRI-Lead_Hyderabad_Ad2_Video",
    adset_id: "as:1", adset_name: "NRI adset", campaign_id: "c:1",
    campaign_name: "CG_Trewellness_FBIG_NRI-Lead_Hyderabad-PostalCode_23June2026",
    form_id: "f:1", form_name: "NRI form", is_organic: "false", platform: "ig",
    "_what_is_your_biggest_health_challenge_today?": "stress_&_fatigue",
    choose_your_wellness_focus: "experience_",
    full_name: `Guest ${n}`, phone_number: `p:+9199000000${String(n).padStart(2, "0")}`,
    email: `guest${n}@example.com`, city: "Hyderabad", lead_status: "CREATED",
    "Primary communication": "called, no answer", "Handled by": "REP",
    ...extra,
  };
  return HEADER.map((h) => base[h] ?? "");
};

describe("parseLeadRows", () => {
  it("maps a sheet whose header is row 1", () => {
    const { leads, headerRow } = parseLeadRows([HEADER, row(1), row(2)]);
    expect(headerRow).toBe(1);
    expect(leads).toHaveLength(2);
    expect(leads[0]).toMatchObject({
      rowNumber: 2, metaId: "l:100000000000001", fullName: "Guest 1", phone: "+919900000001",
      email: "guest1@example.com", city: "Hyderabad", platform: "ig",
    });
    expect(leads[0].answers).toEqual([
      { question: "What is your biggest health challenge today", answer: "stress_&_fatigue" },
      { question: "Choose your wellness focus", answer: "experience_" },
    ]);
  });

  it("handles a sheet where row 1 is a lead and the header is row 2", () => {
    const { leads, headerRow } = parseLeadRows([row(1), HEADER, row(2)]);
    expect(headerRow).toBe(2);
    expect(leads.map((l) => l.rowNumber)).toEqual([1, 3]);
    expect(leads[0].fullName).toBe("Guest 1");
  });

  it("falls back to the p: phone cell when a sheet has no header", () => {
    const { leads, headerRow } = parseLeadRows([row(1), row(2)]);
    expect(headerRow).toBeNull();
    expect(leads[1]).toMatchObject({ fullName: "Guest 2", phone: "+919900000002", email: "guest2@example.com", metaId: "l:100000000000002" });
  });

  it("skips test and do-not-call rows, and rows without a phone", () => {
    const { leads, skipped } = parseLeadRows([
      HEADER,
      row(1, { full_name: "<test lead: dummy data for full_name>" }),
      row(2, { phone_number: "" }),
      row(3),
    ]);
    expect(leads.map((l) => l.rowNumber)).toEqual([4]);
    expect(skipped.map((s) => s.reason)).toEqual(["marked as a test / do-not-call row", "no phone number"]);
  });

  it("ignores staff columns after lead_status", () => {
    const { leads } = parseLeadRows([HEADER, row(1)]);
    expect(leads[0].answers.map((a) => a.answer)).not.toContain("called, no answer");
  });
});

const lead = (rowNumber: number, createdAt: string | null): SheetLead => ({
  rowNumber, metaId: `l:${rowNumber}`, createdTime: createdAt, createdAt: createdAt ? new Date(createdAt) : null,
  fullName: "G", phone: `+9199000000${String(rowNumber).padStart(2, "0")}`, email: null, city: null,
  platform: "ig", campaignName: null, adsetName: null, adName: null, formName: null, isOrganic: false, answers: [],
});

describe("selectLeadsToCheck", () => {
  const now = new Date("2026-09-15T10:00:00Z");
  const leads = Array.from({ length: 30 }, (_, i) => lead(i + 2, `2026-09-${String(1 + Math.floor(i / 3)).padStart(2, "0")}T08:00:00Z`));

  it("checks only the last ten on the very first run", () => {
    const { toCheck } = selectLeadsToCheck(leads, null, now);
    expect(toCheck.map((l) => l.rowNumber)).toEqual([22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
  });

  it("adds every row appended since the last run, beyond the last ten", () => {
    const { toCheck } = selectLeadsToCheck(leads, { lastRowNumber: 12, lastCheckedAt: null }, now);
    expect(toCheck[0].rowNumber).toBe(13);
    expect(toCheck).toHaveLength(19);
  });

  it("adds rows dated since the last run (with a day's overlap), even if not appended", () => {
    const { toCheck } = selectLeadsToCheck(leads, { lastRowNumber: 31, lastCheckedAt: new Date("2026-09-05T08:00:00Z") }, now);
    // Dated 4 Sep onwards = rows from index 9.
    expect(toCheck[0].rowNumber).toBe(11);
  });

  it("holds back rows under an hour old — n8n may not have sent them yet", () => {
    const fresh = [...leads, lead(40, "2026-09-15T09:30:00Z")];
    const { toCheck, tooRecent } = selectLeadsToCheck(fresh, null, now);
    expect(tooRecent.map((l) => l.rowNumber)).toEqual([40]);
    expect(toCheck.map((l) => l.rowNumber)).not.toContain(40);
  });
});

describe("isInCrm", () => {
  const crm = { externalRefs: new Set(["l:5"]), phoneKeys: new Set(["9900000007"]), emails: new Set(["a@b.com"]) };
  it("matches the Meta lead id, the last ten phone digits, or the email", () => {
    expect(isInCrm(lead(5, null), crm)).toBe(true);
    expect(isInCrm({ ...lead(6, null), phone: "9900000007" }, crm)).toBe(true);
    expect(isInCrm({ ...lead(8, null), email: "A@b.com" }, crm)).toBe(true);
    expect(isInCrm(lead(9, null), crm)).toBe(false);
  });
  it("keys phones on their last ten digits", () => {
    expect(phoneKey("p:+91 99000-00007")).toBe("9900000007");
    expect(phoneKey("12345")).toBeNull();
  });
});

describe("buildPushPayload", () => {
  it("builds what n8n would have sent, keyed on the Meta lead id", () => {
    const [l] = parseLeadRows([HEADER, row(1)]).leads;
    const { payload, externalRef } = buildPushPayload(l, null);
    expect(externalRef).toBe("l:100000000000001");
    expect(payload).toMatchObject({
      fullName: "Guest 1", phone: "+919900000001", email: "guest1@example.com", city: "Hyderabad",
      source: "instagram", campaignLabel: "NRI Lead Campaign", packagePreference: "Stress Relief Relaxation",
    });
    expect(payload.intakeNotes).toContain("What is your biggest health challenge today: stress_&_fatigue");
    expect(payload.intakeNotes).toContain("sheet row 2");
  });

  it("prefers the sheet's configured campaign label", () => {
    const [l] = parseLeadRows([HEADER, row(1)]).leads;
    expect(buildPushPayload(l, "My Campaign").payload.campaignLabel).toBe("My Campaign");
  });

  it("recognises the four campaigns, AP/TEL before HYD", () => {
    expect(canonicalCampaign({ campaignName: "CG_Trewellness_SummerDetox_Lead_6June2026_AP&Telangna", adsetName: null, adName: null, formName: null }))
      .toBe("Seasonal Detox Campaign AP/TEL");
    expect(canonicalCampaign({ campaignName: "CG_Trewellness_SeasonalDetox_Lead_6June2026_Hyderabad", adsetName: null, adName: null, formName: null }))
      .toBe("Seasonal Detox Campaign HYD");
  });
});

describe("isDue", () => {
  const now = new Date("2026-09-15T03:30:00Z");
  it("runs when there has never been a run, or the interval has passed", () => {
    expect(isDue(null, 3, now)).toBe(true);
    expect(isDue(new Date("2026-09-12T03:30:00Z"), 3, now)).toBe(true);
  });
  it("tolerates a run that started slightly late last time", () => {
    expect(isDue(new Date("2026-09-12T04:10:00Z"), 3, now)).toBe(true);
  });
  it("waits until the interval is up", () => {
    expect(isDue(new Date("2026-09-13T03:30:00Z"), 3, now)).toBe(false);
  });
});

describe("google-sheets helpers", () => {
  it("parses spreadsheet id and tab from the forms Google produces", () => {
    const id = "1taJgixFhr6fTGfgWOLTuFfA5IHoKZJ6tjlM9IkUNCrE";
    expect(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=1918131243#gid=1918131243`)).toEqual({ spreadsheetId: id, gid: "1918131243" });
    expect(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toEqual({ spreadsheetId: id, gid: "0" });
    expect(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=drivesdk`)).toEqual({ spreadsheetId: id, gid: null });
    expect(parseSheetUrl("https://example.com/sheet")).toBeNull();
  });

  it("signs a JWT the token endpoint can verify", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sa = {
      client_email: "checker@project.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      token_uri: "https://oauth2.googleapis.com/token",
    };
    const jwt = buildJwtAssertion(sa, 1_800_000_000);
    const [h, c, s] = jwt.split(".");
    const ok = crypto.createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toMatchObject({
      iss: sa.client_email, aud: sa.token_uri, iat: 1_800_000_000, exp: 1_800_003_600,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    });
  });
});
