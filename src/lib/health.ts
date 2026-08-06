import { z } from "zod";

/**
 * Health record model — mirrors the Trē pre-booking medical screening form
 * (https://trewellness.in/pre-booking-guest-medical-screening-form/).
 * The whole record is serialised to JSON and AES-256-GCM encrypted before it
 * is written to Postgres (see src/lib/crypto.ts, HealthProfile model).
 *
 * Demographics already captured on Guest (name, phone, dob, gender, city) are
 * NOT duplicated here.
 */

export const ALLERGY_OPTIONS = [
  "Food",
  "Medicines",
  "External allergies",
  "None",
] as const;

export const SUBSTANCE_OPTIONS = [
  "Tea",
  "Coffee",
  "Smoking",
  "Alcohol",
  "Zarda",
  "Drugs",
  "Paan masala",
  "E-cigarettes",
  "Tobacco",
  "Sugar",
  "None",
] as const;

export const PURPOSE_OPTIONS = [
  "Experience",
  "Detox",
  "Healing",
  "De-Stress",
  "Rejuvenation",
  "Lifestyle management",
] as const;

export const ACCOMMODATION_OPTIONS = [
  "Executive room",
  "Premium room",
  "Suite",
] as const;

/** A yes/no answer with optional free-text detail (conditional in the form). */
const yesNoDetail = z.object({
  flag: z.boolean().default(false),
  detail: z.string().optional().default(""),
});
export type YesNoDetail = z.infer<typeof yesNoDetail>;

export const healthRecordSchema = z.object({
  // Vitals / personal (not on Guest)
  heightCm: z.string().optional().default(""),
  weightKg: z.string().optional().default(""),
  bloodGroup: z.string().optional().default(""),
  occupation: z.string().optional().default(""),
  maritalStatus: z.string().optional().default(""),
  address: z.string().optional().default(""),
  emergencyContact: z.string().optional().default(""),

  // Health conditions
  hasHealthIssues: z.boolean().default(false),
  healthIssues: z.string().optional().default(""),
  medications: z.string().optional().default(""),

  // Medical history (Yes/No + detail)
  recentSurgeries: yesNoDetail.default({ flag: false, detail: "" }),
  infectiousSkinDisease: yesNoDetail.default({ flag: false, detail: "" }),
  heartDisease: yesNoDetail.default({ flag: false, detail: "" }),
  psychiatricHistory: yesNoDetail.default({ flag: false, detail: "" }),
  kidneyLiverLung: yesNoDetail.default({ flag: false, detail: "" }),
  seizures: yesNoDetail.default({ flag: false, detail: "" }),
  hernia: yesNoDetail.default({ flag: false, detail: "" }),
  disability: yesNoDetail.default({ flag: false, detail: "" }),
  canWalk1km: yesNoDetail.default({ flag: true, detail: "" }),

  // Allergies & substances
  allergies: z.array(z.string()).default([]),
  allergyDetails: z.string().optional().default(""),
  substanceReliance: z.array(z.string()).default([]),

  // Visit
  purposeOfVisit: z.string().optional().default(""),
  preferredCheckIn: z.string().optional().default(""),
  preferredCheckOut: z.string().optional().default(""),
  accommodationType: z.string().optional().default(""),

  // History
  priorWellnessExperience: z.boolean().default(false),
  priorWellnessDetails: z.string().optional().default(""),

  // Care plan (filled by doctor)
  dietNotes: z.string().optional().default(""),
  doctorNotes: z.string().optional().default(""),
});

export type HealthRecord = z.infer<typeof healthRecordSchema>;

export function emptyHealthRecord(): HealthRecord {
  return healthRecordSchema.parse({});
}

// ---------------------------------------------------------------------------
// Declarative form config — drives the editor UI generically.
// ---------------------------------------------------------------------------
export type FieldType =
  | "text"
  | "number"
  | "textarea"
  | "date"
  | "select"
  | "yesno"
  | "checkboxGroup"
  | "boolWithDetails";

export interface FieldDef {
  key: keyof HealthRecord;
  label: string;
  type: FieldType;
  options?: readonly string[];
  detailLabel?: string;
}

export interface SectionDef {
  title: string;
  fields: FieldDef[];
}

export const HEALTH_SECTIONS: SectionDef[] = [
  {
    title: "Vitals & personal",
    fields: [
      { key: "heightCm", label: "Height (cm)", type: "number" },
      { key: "weightKg", label: "Weight (kg)", type: "number" },
      { key: "bloodGroup", label: "Blood group", type: "text" },
      { key: "occupation", label: "Occupation", type: "text" },
      { key: "maritalStatus", label: "Marital status", type: "text" },
      { key: "emergencyContact", label: "Emergency contact (name & number)", type: "text" },
      { key: "address", label: "Address", type: "textarea" },
    ],
  },
  {
    title: "Health conditions",
    fields: [
      { key: "hasHealthIssues", label: "Has health issues?", type: "yesno" },
      { key: "healthIssues", label: "List health issues", type: "textarea" },
      { key: "medications", label: "Current medications / supplements", type: "textarea" },
    ],
  },
  {
    title: "Medical history",
    fields: [
      { key: "recentSurgeries", label: "Recent surgeries", type: "boolWithDetails" },
      { key: "infectiousSkinDisease", label: "Infectious / skin disease", type: "boolWithDetails" },
      { key: "heartDisease", label: "Heart disease / cardiac procedures", type: "boolWithDetails" },
      { key: "psychiatricHistory", label: "Psychiatric medication / intervention history", type: "boolWithDetails" },
      { key: "kidneyLiverLung", label: "Kidney / liver / lung disease", type: "boolWithDetails" },
      { key: "seizures", label: "Seizures / epilepsy (past 5 years)", type: "boolWithDetails" },
      { key: "hernia", label: "Hernia", type: "boolWithDetails" },
      { key: "disability", label: "Physical / visual disability", type: "boolWithDetails" },
      { key: "canWalk1km", label: "Can walk 1 km without support", type: "boolWithDetails" },
    ],
  },
  {
    title: "Allergies & substances",
    fields: [
      { key: "allergies", label: "Allergies", type: "checkboxGroup", options: ALLERGY_OPTIONS },
      { key: "allergyDetails", label: "Allergy details", type: "textarea" },
      { key: "substanceReliance", label: "Substance reliance", type: "checkboxGroup", options: SUBSTANCE_OPTIONS },
    ],
  },
  {
    title: "Visit & accommodation",
    fields: [
      { key: "purposeOfVisit", label: "Purpose of visit", type: "select", options: PURPOSE_OPTIONS },
      { key: "preferredCheckIn", label: "Preferred check-in", type: "date" },
      { key: "preferredCheckOut", label: "Preferred check-out", type: "date" },
      { key: "accommodationType", label: "Accommodation type", type: "select", options: ACCOMMODATION_OPTIONS },
      { key: "priorWellnessExperience", label: "Prior wellness-centre experience?", type: "yesno" },
      { key: "priorWellnessDetails", label: "Previous centre details", type: "textarea" },
    ],
  },
  {
    title: "Care plan (doctor)",
    fields: [
      { key: "dietNotes", label: "Diet notes (curated by dietician)", type: "textarea" },
      { key: "doctorNotes", label: "Doctor notes", type: "textarea" },
    ],
  },
];
