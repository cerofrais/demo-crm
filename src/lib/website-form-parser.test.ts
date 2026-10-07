import { describe, expect, it } from "vitest";
import {
  formatWebsiteFormNotes,
  landingFormProgram,
  parseFormDate,
  parseLandingPageForm,
  parseWebsiteFormEmail,
} from "./website-form-parser";

// Real sample bodies from trewellness.in's Contact/Accommodation/Therapies
// forms (identical shape) — Name, Age, Email, Phone, City, Preferred Check
// in Date, Message.
const CONTACT_BODY = `Name : Ms Sejal Parmar Age : 30 Email : info@stwi.in Phone : 7574841963 City : Ahmedabad Preferred Check in Date : 2026-07-29
Message: test from STWI`;

describe("parseWebsiteFormEmail — contact/accommodation/therapies shape", () => {
  it("extracts every field", () => {
    const lead = parseWebsiteFormEmail(CONTACT_BODY);
    expect(lead).toEqual({
      fullName: "Sejal Parmar",
      email: "info@stwi.in",
      phone: "+917574841963",
      age: 30,
      city: "Ahmedabad",
      businessName: null,
      businessRole: null,
      checkinDate: "2026-07-29",
      package: null,
      lookingFor: null,
      wellnessFocus: null,
      message: "test from STWI",
      pageUrl: null,
    });
  });

  it("strips the Mr/Ms salutation embedded in the name value", () => {
    expect(parseWebsiteFormEmail(CONTACT_BODY)?.fullName).toBe("Sejal Parmar");
  });
});

// Disease Management — Page URL, Name (no salutation), Email, Phone (already
// E.164), Package, Looking For; no Message.
const DISEASE_MANAGEMENT_BODY =
  "Page URL : https://trewellness.in/disease-management/ Name : Sejal Parmar Email : info@stwi.in Phone : +917574841963 Package : Disease Management Looking For : Stress Relief & Relaxation, Metabolic & Hormonal Balance";

describe("parseWebsiteFormEmail — disease-management shape", () => {
  it("extracts fields including an already-E.164 phone and a comma-list value", () => {
    const lead = parseWebsiteFormEmail(DISEASE_MANAGEMENT_BODY);
    expect(lead?.fullName).toBe("Sejal Parmar");
    expect(lead?.phone).toBe("+917574841963");
    expect(lead?.package).toBe("Disease Management");
    expect(lead?.lookingFor).toBe("Stress Relief & Relaxation, Metabolic & Hormonal Balance");
    expect(lead?.pageUrl).toBe("https://trewellness.in/disease-management/");
    expect(lead?.message).toBeNull();
  });
});

// Offers — minimal: Name, Phone, Email, Package Preference.
const OFFERS_BODY = "Name: Sejal Parmar Phone: 7574841963 Email: info@stwi.in Package Preference: Weekend Offer";

describe("parseWebsiteFormEmail — offers shape", () => {
  it("maps 'Package Preference' to the same field as bare 'Package'", () => {
    const lead = parseWebsiteFormEmail(OFFERS_BODY);
    expect(lead?.package).toBe("Weekend Offer");
    expect(lead?.age).toBeNull();
    expect(lead?.city).toBeNull();
  });
});

// Packages — the richest shape: adds Package Preference AND Wellness Focus
// alongside the contact-form fields.
const PACKAGES_BODY =
  "Name: Ms Sejal Parmar Age : 30 Phone: 7574841963 Email : info@stwi.in City : Ahmedabad Preferred Check in Date : 2026-07-29 Package Preference: Holistic Healing Wellness Focus : Beauty & Skin Rejuvenation, Chronic Condition & Disease Management \nMessage : test from STWI";

describe("parseWebsiteFormEmail — packages shape", () => {
  it("extracts every field including wellness focus", () => {
    const lead = parseWebsiteFormEmail(PACKAGES_BODY);
    expect(lead?.fullName).toBe("Sejal Parmar");
    expect(lead?.age).toBe(30);
    expect(lead?.package).toBe("Holistic Healing");
    expect(lead?.wellnessFocus).toBe("Beauty & Skin Rejuvenation, Chronic Condition & Disease Management");
    expect(lead?.message).toBe("test from STWI");
  });
});

describe("parseWebsiteFormEmail — not a form email", () => {
  it("returns null for a normal reply with no recognizable labels", () => {
    expect(parseWebsiteFormEmail("Thanks, see you at 5pm tomorrow!")).toBeNull();
  });

  it("returns null when Name is present but Email is missing", () => {
    expect(parseWebsiteFormEmail("Name : Sejal Parmar Phone : 7574841963")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseWebsiteFormEmail("")).toBeNull();
  });
});

describe("formatWebsiteFormNotes", () => {
  it("formats every leftover field as a labeled line, omitting empty ones", () => {
    const lead = parseWebsiteFormEmail(PACKAGES_BODY)!;
    expect(formatWebsiteFormNotes(lead)).toBe(
      [
        "Age: 30",
        "Preferred check-in: 2026-07-29",
        "Package: Holistic Healing",
        "Wellness focus: Beauty & Skin Rejuvenation, Chronic Condition & Disease Management",
        "Message: test from STWI",
      ].join("\n"),
    );
  });

  it("returns undefined when there's nothing left to note", () => {
    const lead = parseWebsiteFormEmail("Name : Sejal Parmar Email : info@stwi.in")!;
    expect(formatWebsiteFormNotes(lead)).toBeUndefined();
  });
});

describe("parseFormDate", () => {
  it("reads the form's own ISO format", () => {
    expect(parseFormDate("2026-08-15")?.toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });

  it("reads day-first numeric dates (Indian convention)", () => {
    expect(parseFormDate("15/08/2026")?.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(parseFormDate("5-8-26")?.toISOString()).toBe("2026-08-05T00:00:00.000Z");
  });

  it("reads written months either way round", () => {
    expect(parseFormDate("15 Aug 2026")?.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(parseFormDate("15 August 2026")?.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(parseFormDate("Aug 15, 2026")?.toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });

  // UTC midnight is the point: IST is UTC+5:30, so the stored instant lands
  // on the same calendar day in the only timezone this CRM renders.
  it("anchors at UTC midnight so the IST calendar day matches", () => {
    const d = parseFormDate("2026-08-15")!;
    const ist = new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
    expect(ist).toBe("15/08/2026");
  });

  it("declines free text rather than guessing — it stays in the notes", () => {
    expect(parseFormDate("flexible")).toBeNull();
    expect(parseFormDate("mid August")).toBeNull();
    expect(parseFormDate("")).toBeNull();
  });

  it("rejects an impossible date instead of rolling it forward", () => {
    expect(parseFormDate("31/02/2026")).toBeNull();
    expect(parseFormDate("2026-13-01")).toBeNull();
  });
});

describe("business name and role", () => {
  // The live forms don't send these yet, so the label list is wide on
  // purpose. These pin the wordings it has to survive — a form that starts
  // saying "Designation" instead of "Role" must not silently drop the value.
  const WITH_BUSINESS = `Dear Mr Anil Rao,

Name : Mr Anil Rao
Age : 44
Email : anil@acme.co
Phone : 9949041676
City : Hyderabad
Business Name : Acme Wellness Pvt Ltd
Role : Managing Director
Message: interested in a corporate retreat`;

  it("extracts business name and role alongside the usual fields", () => {
    const lead = parseWebsiteFormEmail(WITH_BUSINESS);
    expect(lead?.businessName).toBe("Acme Wellness Pvt Ltd");
    expect(lead?.businessRole).toBe("Managing Director");
    // The value must stop at the next label, not swallow it.
    expect(lead?.city).toBe("Hyderabad");
    expect(lead?.message).toBe("interested in a corporate retreat");
  });

  it.each([
    ["Company Name", "businessName"],
    ["Company", "businessName"],
    ["Organisation", "businessName"],
    ["Organization Name", "businessName"],
    ["Designation", "businessRole"],
    ["Job Title", "businessRole"],
    ["Occupation", "businessRole"],
    ["Profession", "businessRole"],
  ])("reads %s as %s", (label, field) => {
    const body = `Name : Test Person\nEmail : t@example.com\n${label} : Something Ltd\nCity : Pune`;
    const lead = parseWebsiteFormEmail(body);
    expect(lead?.[field as "businessName" | "businessRole"]).toBe("Something Ltd");
    expect(lead?.city).toBe("Pune");
  });

  it("leaves both null when the form doesn't send them", () => {
    const lead = parseWebsiteFormEmail("Name : A B\nEmail : ab@example.com\nCity : Goa");
    expect(lead?.businessName).toBeNull();
    expect(lead?.businessRole).toBeNull();
  });
});

describe("landing-page programme forms", () => {
  // Real notification bodies (as stored), tracking pixel link included.
  const PIXEL = "[https://baggchdb.r.bh.d.sendibt3.com/tr/op/abc123]";
  const bodies = {
    weightLoss: {
      subject: "New Weight Loss Management Inquiry - trewellness.in",
      text: `${PIXEL} Dear test Following is your inquiry detail submitted for the Weight Loss Management Program at TRE Wellness. Your Name : Priya Sharma Contact No : 9876543210 Email ID : Priya@Example.com Retreat Dates : 2026-09-25 Thanks, TRE Wellness - Weight Loss Management Program trewellness.in Tel No.:- +91 87126 23060`,
    },
    sleep: {
      subject: "New Sleep Restoration Inquiry - trewellness.in",
      text: `${PIXEL} Dear Admin, A new inquiry has been submitted for the Sleep Restoration Program at trewellness: Name : Sejal Contact No : 7574841963 Preferred Program : 7-Day Rapid Reset Tentative Retreat Dates : 2026-09-19 Thanks, TRE Wellness - Sleep Restoration trewellness.in Tel No.:- +91 87126 23060`,
    },
    bridal: {
      subject: "New Bridal Campaign Inquiry - trewellness.in",
      text: `${PIXEL} Dear Harsh Parekh Following is your inquiry detail submitted at trewellness Your Name : Harsh Parekh Contact No : 7574841963 Email ID : stwi.developer@gmail.com Wedding Date : 2026-10-10 Retreat Date : 2026-09-26 Thanks, Bridal Wellness Retreat trewellness.in Tel No.:- +91 87126 23060`,
    },
    hormones: {
      subject: "New Harmonising Hormones Inquiry - trewellness.in",
      text: `${PIXEL} Dear Anu Following is your inquiry detail submitted for the Harmonising Hormones Program at TRE Wellness. Your Name : Anu Rao Contact No : +91 99887 76655 Email ID : anu@example.com Preferred Dates : 2026-09-25 Thanks, TRE Wellness - Harmonising Hormones Program trewellness.in Tel No.:- +91 87126 23060`,
    },
  };

  it("reads the Weight Loss form: Email ID and Contact No included", () => {
    const lead = parseLandingPageForm(bodies.weightLoss.subject, bodies.weightLoss.text)!;
    expect(lead.fullName).toBe("Priya Sharma");
    expect(lead.phone).toBe("+919876543210");
    expect(lead.email).toBe("priya@example.com");
    expect(lead.checkinDate).toBe("2026-09-25");
    expect(lead.program).toBe("Weight Loss Management");
    expect(lead.pageUrl).toBe("https://trewellness.in/weightloss/");
  });

  it("accepts the Sleep Restoration form, which has no email, and keeps the chosen programme", () => {
    const lead = parseLandingPageForm(bodies.sleep.subject, bodies.sleep.text)!;
    expect(lead.fullName).toBe("Sejal");
    expect(lead.phone).toBe("+917574841963");
    expect(lead.email).toBeNull();
    expect(lead.package).toBe("7-Day Rapid Reset");
    expect(lead.checkinDate).toBe("2026-09-19");
  });

  it("keeps the wedding date apart from the retreat date on the Bridal form", () => {
    const lead = parseLandingPageForm(bodies.bridal.subject, bodies.bridal.text)!;
    expect(lead.weddingDate).toBe("2026-10-10");
    expect(lead.checkinDate).toBe("2026-09-26");
    expect(formatWebsiteFormNotes(lead)).toContain("Wedding date: 2026-10-10");
  });

  it("reads Preferred Dates on the Harmonising Hormones form and a +91 number with spaces", () => {
    const lead = parseLandingPageForm(bodies.hormones.subject, bodies.hormones.text)!;
    expect(lead.phone).toBe("+919988776655");
    expect(lead.checkinDate).toBe("2026-09-25");
  });

  it("never takes our own number from the signature", () => {
    for (const b of Object.values(bodies)) {
      const lead = parseLandingPageForm(b.subject, b.text)!;
      expect(lead.phone).not.toBe("+918712623060");
      // …and the last field stops at the sign-off rather than swallowing it.
      expect(lead.checkinDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("puts the programme and page into the lead's notes", () => {
    const note = formatWebsiteFormNotes(parseLandingPageForm(bodies.sleep.subject, bodies.sleep.text)!);
    expect(note).toContain("Programme: Sleep Restoration");
    expect(note).toContain("Submitted via: https://trewellness.in/sleep-restoration/");
  });

  it("ignores anything that isn't one of these notifications", () => {
    // A customer's reply to the auto-response is not a new submission.
    expect(parseLandingPageForm("Re: New Weight Loss Management Inquiry - trewellness.in", bodies.weightLoss.text)).toBeNull();
    expect(parseLandingPageForm("Hello", bodies.weightLoss.text)).toBeNull();
    expect(parseLandingPageForm(null, bodies.weightLoss.text)).toBeNull();
    expect(landingFormProgram("New Bridal Campaign Inquiry - trewellness.in")).toBe("Bridal Campaign");
  });

  it("returns null rather than guessing when there is no way to reach the person", () => {
    expect(parseLandingPageForm(bodies.sleep.subject, "Name : Sejal Preferred Program : 7-Day Rapid Reset")).toBeNull();
  });

  it("is invisible to the general parser, which still requires an email", () => {
    // The general parser runs on every inbound email; it must not start
    // accepting phone-only bodies because of this.
    expect(parseWebsiteFormEmail(bodies.sleep.text)).toBeNull();
  });
});
