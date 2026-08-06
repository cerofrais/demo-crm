import { describe, expect, it } from "vitest";
import { formatMedicalFormNotes, parseMedicalScreeningForm } from "./medical-form-parser";

// The exact real sample provided when this feature was scoped (one label per
// line, answer on the following line(s) — this form's mailer's own shape,
// distinct from website-form-parser.ts's colon-delimited run-on body).
const SAMPLE = `First Name
Siddhant
Last Name
Golechhaa
Age
30
Date of Birth
28th November 1995
Father/Spouse name
Mukesh Golechha
Gender
Male
Height (in cms)
175
Weight (in kgs)
71
Blood group
B+
Occupation
Business
Marital status
Un married
Mobile Number
+919963644500
Email
sidd_golechha@hotmail.com
City
Hyderabad
Emergency contact name & contact number
Mukesh Golechha - 9866334500
Do you have any health issues?
No
List your current Medications / Supplements
Just have Micronutrients such as Vitamin B's, C, D3, Electrolytes, Plant Protein and Creatine
1) Have you undergone any surgery in recent years?
No
2) Are you suffering from any infectious disease or skin disease?
No
3) Are you suffering from any heart disease or have undergone angioplasty/bypass/open heart surgery?
No
4) Do you have any past/present history of psychiatric medication/intervention?
No
5) Are you suffering from any kind of kidney/ liver/ lung disease?
No
6) Did you have any episodes of seizure/epilepsy in the past 5 years?
No
7) Do you suffer from any type of hernia?
No
8) Are you physically or visually disabled in anyway?
No
9) Can you walk 1 Kilometre without support?
Yes
10) Are you suffering from any allergies?
None
11) Have you become reliant on any of the below substances?
E-cigarettes
Tobacco
12) Purpose of your visit to trē wellness?
Experience
Detox
Lifestyle management
From
2026-06-12
To
2026-06-13
16) How did you come to know about trē wellness?
Personal reference
17) Have you been to any other naturopathy / ayurveda / wellness centre before?
Yes
If yes, please mention name and duration of stay
Jindal 7 days`;

describe("parseMedicalScreeningForm — real sample", () => {
  const result = parseMedicalScreeningForm(SAMPLE);

  it("parses without returning null", () => {
    expect(result).not.toBeNull();
  });

  it("extracts contact fields, ignoring the redundant Age field", () => {
    expect(result?.contact).toEqual({
      fullName: "Siddhant Golechhaa",
      phone: "+919963644500",
      email: "sidd_golechha@hotmail.com",
      city: "Hyderabad",
      gender: "male",
      dateOfBirth: "1995-11-28",
      fatherSpouseName: "Mukesh Golechha",
      heardAboutUs: "Personal reference",
    });
  });

  it("extracts vitals/personal fields", () => {
    expect(result?.health.heightCm).toBe("175");
    expect(result?.health.weightKg).toBe("71");
    expect(result?.health.bloodGroup).toBe("B+");
    expect(result?.health.occupation).toBe("Business");
    expect(result?.health.maritalStatus).toBe("Un married");
    expect(result?.health.emergencyContact).toBe("Mukesh Golechha - 9866334500");
  });

  it("extracts hasHealthIssues=false with no medications lost", () => {
    expect(result?.health.hasHealthIssues).toBe(false);
    expect(result?.health.medications).toBe(
      "Just have Micronutrients such as Vitamin B's, C, D3, Electrolytes, Plant Protein and Creatine",
    );
  });

  it("extracts every yes/no medical-history flag correctly", () => {
    expect(result?.health.recentSurgeries).toEqual({ flag: false, detail: "" });
    expect(result?.health.infectiousSkinDisease).toEqual({ flag: false, detail: "" });
    expect(result?.health.heartDisease).toEqual({ flag: false, detail: "" });
    expect(result?.health.psychiatricHistory).toEqual({ flag: false, detail: "" });
    expect(result?.health.kidneyLiverLung).toEqual({ flag: false, detail: "" });
    expect(result?.health.seizures).toEqual({ flag: false, detail: "" });
    expect(result?.health.hernia).toEqual({ flag: false, detail: "" });
    expect(result?.health.disability).toEqual({ flag: false, detail: "" });
    expect(result?.health.canWalk1km).toEqual({ flag: true, detail: "" });
  });

  it("extracts allergies as ['None'] (a real checkbox option, not the absence of an answer)", () => {
    expect(result?.health.allergies).toEqual(["None"]);
  });

  it("extracts a multi-line checkbox answer (substance reliance) as an array", () => {
    expect(result?.health.substanceReliance).toEqual(["E-cigarettes", "Tobacco"]);
  });

  it("joins a multi-line purpose-of-visit answer into one comma string", () => {
    expect(result?.health.purposeOfVisit).toBe("Experience, Detox, Lifestyle management");
  });

  it("extracts check-in/check-out dates from the bare From/To labels", () => {
    expect(result?.health.preferredCheckIn).toBe("2026-06-12");
    expect(result?.health.preferredCheckOut).toBe("2026-06-13");
  });

  it("extracts prior wellness experience and its conditional detail follow-up", () => {
    expect(result?.health.priorWellnessExperience).toBe(true);
    expect(result?.health.priorWellnessDetails).toBe("Jindal 7 days");
  });

  it("does not set any field for a question the form omitted (none of these were asked)", () => {
    expect(result?.health.dietNotes).toBeUndefined();
    expect(result?.health.doctorNotes).toBeUndefined();
    expect(result?.health.accommodationType).toBeUndefined();
  });
});

// A second real submission (guest +919391529942) that surfaced real gaps in
// the parser above: markdown-bolded labels (mail client renders "*Label*"),
// long questions word-wrapped across two lines, a DD/MM/YYYY date, an
// allergy question with a "Please explain in detail:" follow-up (which must
// NOT be treated as a 4th checkbox option), and two labels the first sample
// never exercised ("List your health issues", "14) Preferred type of
// accommodation").
const WRAPPED_SAMPLE = `*First Name*
Megha
*Last Name*
Malhari
*Age*
26
*Date of Birth*
23/01/2000
*Father/Spouse name*
Nalini mohan
*Gender*
Female
*Height (in cms)*
167
*Weight (in kgs)*
82
*Blood group*
AB+
*Occupation*
Senior Business accountant
*Marital status*
Unmarried
*Mobile Number*
+919391529942
*Email*
mghmalhari@gmail.com
*City*
Hyderabad
*Do you have any health issues?*
Yes
*List your health issues*
Thyroid
Pcos
Stress
Over weight
Sleep
*List your current Medications / Supplements*
Thyroid medicine
*1) Have you undergone any surgery in recent years?*
No
*2) Are you suffering from any infectious disease or skin disease?*
No
*3) Are you suffering from any heart disease or have undergone
angioplasty/bypass/open heart surgery?*
No
*4) Do you have any past/present history of psychiatric
medication/intervention?*
Yes
*If yes, please give details:*
Temporary Depression medication
*5) Are you suffering from any kind of kidney/ liver/ lung disease?*
No
*6) Did you have any episodes of seizure/epilepsy in the past 5 years?*
No
*7) Do you suffer from any type of hernia?*
No
*8) Are you physically or visually disabled in anyway?*
No
*9) Can you walk 1 Kilometre without support?*
Yes
*10) Are you suffering from any allergies?*
External allergies
*Please explain in detail:*
Dust and food allergies- often get cold
*11) Have you become reliant on any of the below substances?*
None
*12) Purpose of your visit to trē wellness?*
Detox
Healing
De-Stress
Rejuvenation
Lifestyle management
*From*
2026-08-03
*To*
2026-08-09
*14) Preferred type of accommodation*
Executive room
*16) How did you come to know about trē wellness?*
Google search
*17) Have you been to any other naturopathy / ayurveda / wellness centre
before?*
No
Sent from Tre Wellness <https://trewellness.in>`;

describe("parseMedicalScreeningForm — real sample with wrapped/markdown labels", () => {
  const result = parseMedicalScreeningForm(WRAPPED_SAMPLE);

  it("parses without returning null despite every label being wrapped in markdown asterisks", () => {
    expect(result).not.toBeNull();
  });

  it("extracts contact fields including a DD/MM/YYYY date of birth", () => {
    expect(result?.contact.fullName).toBe("Megha Malhari");
    expect(result?.contact.phone).toBe("+919391529942");
    expect(result?.contact.dateOfBirth).toBe("2000-01-23");
    expect(result?.contact.gender).toBe("female");
  });

  it("recovers a label that word-wraps across two lines", () => {
    expect(result?.health.heartDisease).toEqual({ flag: false, detail: "" });
  });

  it("uses the dedicated 'List your health issues' label instead of dumping it into the yes/no flag", () => {
    expect(result?.health.hasHealthIssues).toBe(true);
    expect(result?.health.healthIssues).toBe("Thyroid, Pcos, Stress, Over weight, Sleep");
  });

  it("captures a wrapped label's own conditional detail follow-up", () => {
    expect(result?.health.psychiatricHistory).toEqual({
      flag: true,
      detail: "Temporary Depression medication",
    });
  });

  it("keeps a real allergy checkbox option separate from its free-text detail follow-up", () => {
    expect(result?.health.allergies).toEqual(["External allergies"]);
    expect(result?.health.allergyDetails).toBe("Dust and food allergies- often get cold");
  });

  it("extracts the accommodation-type label the first sample never exercised", () => {
    expect(result?.health.accommodationType).toBe("Executive room");
  });

  it("recovers the final wrapped label even with no trailing text after it", () => {
    expect(result?.health.priorWellnessExperience).toBe(false);
  });
});

// A third real submission (guest +919848930043) that broke the line-based
// parser entirely: this mailer variant renders every label and its own
// answer as one continuous word-wrapped paragraph, with no line break
// between them at all — plus a bare DDMMYYYY date, an "Age" field with no
// schema home sitting between Last Name and Date of Birth, and trailing
// passport/visa fields with no schema home either. Verifies the anchor-based
// rewrite (finds each label's text anywhere in the body, rather than
// requiring it to be its own line) against the exact real body.
const FLOWING_SAMPLE = `First Name Siddharth Last Name Reddy Age 35 Date of Birth 13101990 Father/Spouse
name Ramesh Reddy Gender Male Height (in cms) 190 Weight (in kgs) 119 Blood
group O-ve Occupation Business Marital status Single Mobile Number +919848930043
Email siddtreddy@yahoo.co.in [siddtreddy@yahoo.co.in] City Hyderabad Address
Villa 79, Whisper Valley, Sheikpet, Hyderabad, 500008 Emergency contact name &
contact number Lakshmi Reddy 9848052531 Do you have any health issues? Yes List
your health issues sleep, overweight List your current Medications / Supplements
thyroid 1) Have you undergone any surgery in recent years? Yes If yes, please
give details: yes knee surgery 20 years ago 2) Are you suffering from any
infectious disease or skin disease? Yes If yes, please give details: testing 3)
Are you suffering from any heart disease or have undergone
angioplasty/bypass/open heart surgery? Yes If yes, please give details:
heartbreak 4) Do you have any past/present history of psychiatric
medication/intervention? Yes If yes, please give details: all kinds of intense
ones 5) Are you suffering from any kind of kidney/ liver/ lung disease? Yes If
yes, please give details: too much protein shakes so kidney issues 6) Did you
have any episodes of seizure/epilepsy in the past 5 years? Yes If yes, please
give details: when I was a kid 7) Do you suffer from any type of hernia? Yes If
yes, please give details: my friend has 8) Are you physically or visually
disabled in anyway? Yes If yes, please give details: blind by my surroundings 9)
Can you walk 1 Kilometre without support? No If no, please give details: I cant
walk on my hands 10) Are you suffering from any allergies? External allergies
Please explain in detail: spiders and insects, get rash and sometimes
anaphylactic shock 11) Have you become reliant on any of the below substances?
Tea
Coffee
Smoking
Alcohol
Zarda
Drugs
Paan masala
Substance
E-cigarettes
Tobacco
Sugar 12) Purpose of your visit to trē wellness? Experience
Detox
Healing
De-Stress
Rejuvenation
Lifestyle management From 2026-08-15 To 2026-08-16 14) Preferred type of
accommodation Suite Previous date of admission 2020-03-14 16) How did you come
to know about trē wellness? Others If others, please specify probably need to
elaborate on this question than ask only google search social media personal
reference 17) Have you been to any other naturopathy / ayurveda / wellness
centre before? Yes If yes, please mention name and duration of stay wish i went
to 20 more and all come to us Passport number jx500400 Date of issue 2024-09-13
Place of issue Ottawa, Canada Visa duration 5 years

Sent from Tre Wellness [https://trewellness.in]`;

describe("parseMedicalScreeningForm — real sample with no line break between label and answer", () => {
  const result = parseMedicalScreeningForm(FLOWING_SAMPLE);

  it("parses without returning null despite labels and answers running together with no separator", () => {
    expect(result).not.toBeNull();
  });

  it("extracts contact fields, skipping the unmapped Age field and a bracket-duplicated email", () => {
    expect(result?.contact.fullName).toBe("Siddharth Reddy");
    expect(result?.contact.phone).toBe("+919848930043");
    expect(result?.contact.email).toBe("siddtreddy@yahoo.co.in");
    expect(result?.contact.dateOfBirth).toBe("1990-10-13");
  });

  it("parses a bare DDMMYYYY date with no separators", () => {
    expect(result?.contact.dateOfBirth).toBe("1990-10-13");
  });

  it("recovers a Yes/No flag whose detail runs directly into the next question with no separator", () => {
    expect(result?.health.heartDisease).toEqual({ flag: true, detail: "heartbreak" });
    expect(result?.health.canWalk1km).toEqual({ flag: false, detail: "I cant walk on my hands" });
  });

  it("keeps an allergy option separate from its glued-on free-text detail", () => {
    expect(result?.health.allergies).toEqual(["External allergies"]);
    expect(result?.health.allergyDetails).toBe(
      "spiders and insects, get rash and sometimes anaphylactic shock",
    );
  });

  it("still separates each checkbox item onto its own array entry", () => {
    expect(result?.health.substanceReliance).toEqual([
      "Tea", "Coffee", "Smoking", "Alcohol", "Zarda", "Drugs",
      "Paan masala", "Substance", "E-cigarettes", "Tobacco", "Sugar",
    ]);
  });

  it("splits the purpose-of-visit checklist from its glued-on From/To dates", () => {
    expect(result?.health.purposeOfVisit).toBe(
      "Experience, Detox, Healing, De-Stress, Rejuvenation, Lifestyle management",
    );
    expect(result?.health.preferredCheckIn).toBe("2026-08-15");
    expect(result?.health.preferredCheckOut).toBe("2026-08-16");
  });

  it("stops the accommodation type at the unmapped 'Previous date of admission' field", () => {
    expect(result?.health.accommodationType).toBe("Suite");
  });

  it("keeps prior-wellness-experience details clean of trailing unmapped passport/visa fields", () => {
    expect(result?.health.priorWellnessExperience).toBe(true);
    expect(result?.health.priorWellnessDetails).toBe("wish i went to 20 more and all come to us");
  });
});

describe("parseMedicalScreeningForm — fallback behavior", () => {
  it("returns null for a body with no recognized labels at all", () => {
    expect(parseMedicalScreeningForm("Hello, just checking in about my booking.")).toBeNull();
  });

  it("returns null when a name or phone is missing even if some labels matched", () => {
    const bodyMissingPhone = "First Name\nSiddhant\nLast Name\nGolechhaa\nCity\nHyderabad";
    expect(parseMedicalScreeningForm(bodyMissingPhone)).toBeNull();
  });
});

describe("formatMedicalFormNotes", () => {
  it("formats the two fields with no schema home", () => {
    const result = parseMedicalScreeningForm(SAMPLE);
    expect(formatMedicalFormNotes(result!.contact)).toBe(
      "Father/Spouse name: Mukesh Golechha\nHow they heard about us: Personal reference",
    );
  });

  it("returns undefined when neither field is present", () => {
    expect(
      formatMedicalFormNotes({
        fullName: "X", phone: "+911234567890", email: null, city: null,
        gender: null, dateOfBirth: null, fatherSpouseName: null, heardAboutUs: null,
      }),
    ).toBeUndefined();
  });
});
