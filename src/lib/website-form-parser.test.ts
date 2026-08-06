import { describe, expect, it } from "vitest";
import { formatWebsiteFormNotes, parseWebsiteFormEmail } from "./website-form-parser";

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
