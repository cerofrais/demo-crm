import { z } from "zod";
import { STAGE_IDS } from "./kanban";
import { CRM_ROLES } from "./keycloak-roles";

// ---------------------------------------------------------------------------
// Phone validation — international E.164 (accepts all countries, not just +91).
// Format: leading "+", country code (first digit 1-9), then up to 14 more digits
// (E.164 caps the total at 15 digits). Examples: +919876543210, +14155550123.
// ---------------------------------------------------------------------------

/** Regex for any valid E.164 phone number. */
export const PHONE_RE = /^\+[1-9]\d{6,14}$/;
export const PHONE_MSG =
  "Enter the number in international format with country code, e.g. +919876543210 or +14155550123";

/** Returns an error string if the phone is non-empty and invalid, else null. */
export function validatePhone(phone: string): string | null {
  if (!phone) return null;
  return PHONE_RE.test(phone) ? null : PHONE_MSG;
}

// Backward-compatible aliases — these used to be India-only; they now accept any
// country. Kept so existing imports keep working; prefer the names above.
/** @deprecated use PHONE_RE — no longer India-specific */
export const INDIAN_PHONE_RE = PHONE_RE;
/** @deprecated use PHONE_MSG */
export const INDIAN_PHONE_MSG = PHONE_MSG;
/** @deprecated use validatePhone */
export const validateIndianPhone = validatePhone;

const SOURCES = [
  "website_form",
  "whatsapp",
  "instagram",
  "facebook",
  "referral",
  "walk_in",
  "phone",
  "google_sheets",
  "other",
] as const;

export const createEnquirySchema = z.object({
  fullName: z.string().min(1, "Name is required"),
  phone: z.string().regex(PHONE_RE, PHONE_MSG),
  email: z.string().email().optional().or(z.literal("")).transform((v) => v || undefined),
  city: z.string().optional(),
  gender: z.enum(["male", "female", "other"]).optional(),
  source: z.enum(SOURCES),
  campaignLabel: z.string().optional(),
  referralCode: z.string().optional(),
  tags: z.array(z.string()).optional(),
  note: z.string().optional(),
});
export type CreateEnquiryInput = z.infer<typeof createEnquirySchema>;

// Guest-only creation (no Enquiry/lead ticket) — the Guests page's "New
// guest" action, for adding someone to the directory who isn't a sales lead
// (e.g. backfilling a walk-in's record, or someone referred in person).
export const createGuestSchema = z
  .object({
    fullName: z.string().min(1, "Name is required"),
    phone: z.string().regex(PHONE_RE, PHONE_MSG).optional().or(z.literal("")),
    email: z.string().email().optional().or(z.literal("")),
    city: z.string().optional(),
    gender: z.enum(["male", "female", "other"]).optional(),
    dateOfBirth: z.string().optional(), // ISO date (yyyy-mm-dd)
  })
  .refine((v) => v.phone?.trim() || v.email?.trim(), {
    message: "Provide at least a phone number or email",
    path: ["phone"],
  });
export type CreateGuestInput = z.infer<typeof createGuestSchema>;

// Editing an existing guest directory record — same field set as creation,
// but every field is optional (a partial update) and there's no phone/email
// requirement since the record already exists.
export const updateGuestSchema = z.object({
  fullName: z.string().min(1, "Name is required").optional(),
  phone: z.string().regex(PHONE_RE, PHONE_MSG).optional().or(z.literal("")),
  email: z.string().email().optional().or(z.literal("")),
  city: z.string().optional(),
  gender: z.enum(["male", "female", "other"]).optional(),
  dateOfBirth: z.string().optional(), // ISO date (yyyy-mm-dd)
});
export type UpdateGuestInput = z.infer<typeof updateGuestSchema>;

export const moveStageSchema = z.object({
  stage: z.enum(STAGE_IDS as [string, ...string[]]),
  boardPosition: z.number().int().optional(),
});

export const addNoteSchema = z
  .object({
    body: z.string().max(5000).optional().default(""),
    // A voice note or file already uploaded via upload-url/confirm — same
    // "Document scoped to this guest/enquiry" shape as Message attachments.
    attachmentDocumentId: z.string().uuid().optional(),
  })
  .refine((v) => v.body.trim().length > 0 || v.attachmentDocumentId, {
    message: "Note cannot be empty",
    path: ["body"],
  });

export const createTaskSchema = z.object({
  title: z.string().min(1, "Task cannot be empty").max(200),
  amount: z.coerce.number().int().positive().max(365),
  unit: z.enum(["hours", "days"]),
});

export const updateEnquirySchema = z.object({
  fullName: z.string().min(1, "Name is required").optional(),
  phone: z
    .string()
    .regex(INDIAN_PHONE_RE, INDIAN_PHONE_MSG)
    .optional()
    .or(z.literal("")),
  email: z.string().email().optional().or(z.literal("")),
  city: z.string().optional(),
  assignedToSub: z.string().nullable().optional(),
  assignedToName: z.string().nullable().optional(),
  quotedPriceINR: z.number().int().nullable().optional(),
  stage: z.enum(STAGE_IDS as [string, ...string[]]).optional(),
  needsAttention: z.boolean().optional(),
  intakeNotes: z.string().nullable().optional(),
});

export const tagMutationSchema = z
  .object({
    add: z.string().min(1).max(40).optional(),
    remove: z.string().min(1).optional(),
  })
  .refine((d) => d.add || d.remove, { message: "Provide 'add' or 'remove'" });

export const createTagSchema = z.object({ value: z.string().min(1).max(40) });

export const packageSchema = z.object({
  name: z.string().min(1, "Name is required"),
  category: z.enum(["residential", "day", "corporate"]),
  durationDays: z.coerce.number().int().positive(),
  basePriceINR: z.coerce.number().int().nonnegative(),
  therapies: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
});

export const referralSchema = z.object({
  campaignLabel: z.string().optional(),
  maxRedemptions: z.coerce.number().int().nonnegative().default(0),
  issuedToGuestId: z.string().uuid().optional(),
});

const DOC_CATEGORIES = ["medical", "consent", "operational", "marketing"] as const;

export const uploadUrlSchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  category: z.enum(DOC_CATEGORIES),
  // F39: REQUIRED up-front byte size — bound into the presigned PUT so the URL
  // can never be reused/abused to upload a larger object (the cap no longer
  // depends on the client choosing to declare a size).
  sizeBytes: z.number().int().positive(),
  guestId: z.string().uuid().optional(),
  enquiryId: z.string().uuid().optional(),
});

export const confirmUploadSchema = z.object({
  storageKey: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  category: z.enum(DOC_CATEGORIES),
  sizeBytes: z.number().int().nonnegative(),
  guestId: z.string().uuid().optional(),
  enquiryId: z.string().uuid().optional(),
});

// Public website webhook payload (spec §6.3)
export const enquiryWebhookSchema = z.object({
  fullName: z.string().min(1),
  phone: z.string().min(6),
  email: z.string().email().optional(),
  city: z.string().optional(),
  source: z.enum(SOURCES).default("website_form"),
  campaignLabel: z.string().optional(),
  referralCode: z.string().optional(),
  // Lands in Enquiry.intakeNotes. `intakeNotes` is the preferred field name
  // (matches the PATCH /api/enquiries/:id contract); `message` is kept as a
  // deprecated alias so older integrations aren't broken.
  intakeNotes: z.string().optional(),
  message: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Staff user management (Keycloak-backed — admin only)
// ---------------------------------------------------------------------------

const USERNAME_RE = /^[a-z0-9._-]{3,60}$/;

export const createStaffUserSchema = z.object({
  username: z.string().regex(USERNAME_RE, "Lowercase letters, numbers, dots, dashes and underscores only"),
  email: z.string().email(),
  firstName: z.string().min(1, "First name is required").max(80),
  lastName: z.string().min(1, "Last name is required").max(80),
  role: z.enum(CRM_ROLES),
  phone: z.string().regex(PHONE_RE, PHONE_MSG).optional().or(z.literal("")),
});

export const updateStaffUserSchema = z.object({
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  email: z.string().email().optional(),
  enabled: z.boolean().optional(),
  role: z.enum(CRM_ROLES).optional(),
  phone: z.string().regex(PHONE_RE, PHONE_MSG).optional().or(z.literal("")),
});

// ---------------------------------------------------------------------------
// WhatsApp numbers (Evolution API — admin only)
// ---------------------------------------------------------------------------

export const createWhatsAppNumberSchema = z.object({
  label: z.string().min(1, "Label is required").max(80),
  /** Official Meta Cloud API mode instead of the default QR-paired Baileys —
   *  see docs/17-whatsapp-integration.md. Omit for a normal Baileys number. */
  cloudApi: z
    .object({
      token: z.string().min(1, "Access token is required"),
      phoneNumberId: z.string().min(1, "Phone Number ID is required"),
      wabaId: z.string().min(1, "WhatsApp Business Account ID is required"),
    })
    .optional(),
});

export const updateWhatsAppNumberSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  isDefault: z.boolean().optional(),
  shared: z.boolean().optional(),
});

export const sendWhatsAppMessageSchema = z
  .object({
    guestId: z.string().uuid(),
    enquiryId: z.string().uuid().optional(),
    numberId: z.string().uuid(),
    body: z.string().optional(),
    /** A Document already created via /api/files/upload-url + /confirm — sent
     * as the WhatsApp media, with `body` (if any) as the caption. */
    attachmentDocumentId: z.string().uuid().optional(),
  })
  .refine((d) => (d.body && d.body.trim().length > 0) || d.attachmentDocumentId, {
    message: "Message body or an attachment is required",
    path: ["body"],
  });
