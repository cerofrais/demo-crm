/* eslint-disable no-console */
import { PrismaClient, type EnquiryStage, type LeadSource } from "@prisma/client";
import { encryptJson } from "../src/lib/crypto";
import { emptyHealthRecord } from "../src/lib/health";
import { mergeLeadTags } from "../src/lib/lead-tags";

const prisma = new PrismaClient();

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function daysAgo(n: number) { return new Date(NOW - n * DAY); }
function daysFrom(n: number) { return new Date(NOW + n * DAY); }
function hoursAgo(n: number) { return new Date(NOW - n * HOUR); }
function hoursFrom(n: number) { return new Date(NOW + n * HOUR); }

// ---------------------------------------------------------------------------
// Staff identities — mirror Keycloak test users in realm-export.json.
// In production assignedToSub is the real Keycloak sub; seed uses stable IDs.
// ---------------------------------------------------------------------------
const STAFF = {
  manager:   { sub: "seed-manager",   name: "Manish Manager",  phone: "+919700000001" },
  reception: { sub: "seed-reception", name: "Riya Reception",  phone: "+919700000002" },
  admin:     { sub: "seed-admin",     name: "Asha Admin",      phone: "+919700000003" },
};

// ---------------------------------------------------------------------------
// Lead sample — drives guest + enquiry creation
// ---------------------------------------------------------------------------
const sample: Array<{
  fullName: string;
  phone: string;
  email?: string;
  city: string;
  gender: string;
  age: number;
  stage: EnquiryStage;
  source: LeadSource;
  tags: string[];
  assignee?: typeof STAFF.manager;
  isReturning?: boolean;
  quotedPriceINR?: number;
  needsAttention?: boolean;
  attentionReason?: string;
}> = [
  {
    fullName: "Ananya Rao", phone: "+919811111111", email: "ananya@example.com",
    city: "Bengaluru", gender: "female", age: 34,
    stage: "new_lead", source: "instagram", tags: ["detox", "ig-campaign"],
  },
  {
    fullName: "Vikram Shah", phone: "+919822222222", email: "vikram@example.com",
    city: "Mumbai", gender: "male", age: 41,
    stage: "contacted", source: "website_form", tags: ["stress"], assignee: STAFF.reception,
    needsAttention: true,
    attentionReason: "Client replied to intro email asking for a detailed programme overview and pricing.",
  },
  {
    fullName: "Priya Menon", phone: "+919833333333",
    city: "Kochi", gender: "female", age: 29,
    stage: "rnr", source: "facebook", tags: ["rejuvenation"], assignee: STAFF.reception,
    needsAttention: true,
    attentionReason: "Follow-up tasks scheduled — 2-2-2 cadence triggered after moving to RNR.",
  },
  {
    fullName: "Rahul Gupta", phone: "+919844444444", email: "rahul@example.com",
    city: "Delhi", gender: "male", age: 52,
    stage: "qualified", source: "referral", tags: ["healing", "high-intent"], assignee: STAFF.manager,
  },
  {
    fullName: "Sneha Iyer", phone: "+919855555555", email: "sneha@example.com",
    city: "Chennai", gender: "female", age: 38,
    stage: "pricing_shared", source: "phone", tags: ["lifestyle"], assignee: STAFF.manager,
    quotedPriceINR: 98000,
    needsAttention: true,
    attentionReason: "Inbound email received: client asking if the quoted price includes doctor consultations.",
  },
  {
    fullName: "Arjun Nair", phone: "+919866666666", email: "arjun@example.com",
    city: "Pune", gender: "male", age: 45,
    stage: "doctor_consultation", source: "website_form", tags: ["detox"], assignee: STAFF.reception,
    quotedPriceINR: 126000,
  },
  {
    fullName: "Meera Krishnan", phone: "+919877777777", email: "meera@example.com",
    city: "Hyderabad", gender: "female", age: 47,
    stage: "booking_confirmed", source: "referral", tags: ["healing", "vip"], assignee: STAFF.manager,
    quotedPriceINR: 154000, isReturning: true,
    needsAttention: true,
    attentionReason: "Returning client emailed: requesting room preferences and arrival logistics before check-in.",
  },
  {
    fullName: "Karan Malhotra", phone: "+919888888888", email: "karan@example.com",
    city: "Gurugram", gender: "male", age: 36,
    stage: "converted", source: "instagram", tags: ["de-stress"], assignee: STAFF.manager,
    quotedPriceINR: 112000, isReturning: true,
  },
  {
    fullName: "Divya Pillai", phone: "+919899999999",
    city: "Trivandrum", gender: "female", age: 31,
    stage: "lost", source: "facebook", tags: ["price-objection"], assignee: STAFF.reception,
  },
];

// ---------------------------------------------------------------------------
async function main() {
  console.log("Seeding Trē CRM…");

  // -- Packages --------------------------------------------------------------
  const [residential, day] = await Promise.all([
    prisma.package.upsert({
      where: { id: "pkg-residential-7" },
      update: {},
      create: {
        id: "pkg-residential-7",
        name: "7-Day Residential Detox",
        category: "residential",
        durationDays: 7,
        basePriceINR: 98000,
        therapies: ["Abhyanga", "Shirodhara", "Nutrition consult", "Yoga"],
      },
    }),
    prisma.package.upsert({
      where: { id: "pkg-day-stress" },
      update: {},
      create: {
        id: "pkg-day-stress",
        name: "Day De-Stress Programme",
        category: "day",
        durationDays: 1,
        basePriceINR: 14000,
        therapies: ["Massage", "Meditation"],
      },
    }),
    prisma.package.upsert({
      where: { id: "pkg-corporate-wellness" },
      update: {},
      create: {
        id: "pkg-corporate-wellness",
        name: "Corporate Wellness Retreat",
        category: "corporate",
        durationDays: 3,
        basePriceINR: 45000,
        therapies: ["Yoga", "Mindfulness", "Team breathing sessions"],
      },
    }),
  ]);
  void day; void residential; // used below

  // -- Referral codes --------------------------------------------------------
  const [refCode] = await Promise.all([
    prisma.referralCode.upsert({
      where: { code: "TREWELL10" },
      update: {},
      create: { code: "TREWELL10", campaignLabel: "Launch referral", maxRedemptions: 0 },
    }),
    prisma.referralCode.upsert({
      where: { code: "VIP2026" },
      update: {},
      create: { code: "VIP2026", campaignLabel: "VIP returning guest", maxRedemptions: 50 },
    }),
  ]);
  void refCode;

  // -- Tag vocabulary --------------------------------------------------------
  const customVocab = Array.from(new Set([
    ...sample.flatMap((s) => s.tags),
    "high-intent", "vip", "price-sensitive", "corporate", "nri",
    "urgent", "referral-lead", "ig-campaign", "doctor-ready",
  ]));
  await prisma.tag.createMany({
    data: customVocab.map((value) => ({ value, category: "custom" })),
    skipDuplicates: true,
  });

  // -- Staff profiles (click-to-call phone numbers) --------------------------
  for (const staff of Object.values(STAFF)) {
    await prisma.staffProfile.upsert({
      where: { keycloakId: staff.sub },
      update: { phone: staff.phone, displayName: staff.name },
      create: { keycloakId: staff.sub, displayName: staff.name, phone: staff.phone, isOnline: true },
    });
  }

  // -- Guests + enquiries ----------------------------------------------------
  // Store created enquiry IDs keyed by guest name for later use.
  const enquiryMap: Record<string, { enquiryId: string; guestId: string }> = {};

  for (const s of sample) {
    const dob = new Date();
    dob.setFullYear(dob.getFullYear() - s.age);

    const guest = await prisma.guest.upsert({
      where: { phone: s.phone },
      update: {},
      create: {
        fullName: s.fullName,
        phone: s.phone,
        email: s.email,
        city: s.city,
        gender: s.gender,
        dateOfBirth: dob,
        tags: s.tags,
        isReturning: s.isReturning ?? false,
        consentGiven: true,
        consentAt: new Date(),
        customFields: { ageGroup: s.age < 35 ? "under-35" : s.age < 50 ? "35-49" : "50+" },
      },
    });

    // Health profiles (encrypted AES-256-GCM)
    const healthData: Record<string, ReturnType<typeof encryptJson> | null> = {
      "Meera Krishnan": encryptJson({
        ...emptyHealthRecord(),
        heightCm: "165", weightKg: "68", bloodGroup: "B+",
        hasHealthIssues: true, healthIssues: "Hypertension",
        medications: "Amlodipine 5mg (daily)",
        heartDisease: { flag: false, detail: "" },
        allergies: ["Medicines"], allergyDetails: "Penicillin",
        substanceReliance: ["Coffee"],
        purposeOfVisit: "Healing & rejuvenation",
        dietNotes: "Low-sodium vegetarian; finalise after consult.",
      }),
      "Rahul Gupta": encryptJson({
        ...emptyHealthRecord(),
        heightCm: "175", weightKg: "88", bloodGroup: "O+",
        hasHealthIssues: true, healthIssues: "Type-2 Diabetes, Hypertension",
        medications: "Metformin 500mg (twice daily), Telmisartan 40mg",
        heartDisease: { flag: true, detail: "Mild angina, on monitoring" },
        allergies: [], allergyDetails: "",
        substanceReliance: ["Alcohol (occasional)"],
        purposeOfVisit: "Detox & cardiac wellness",
        dietNotes: "Low glycaemic, low sodium. No red meat.",
      }),
      "Arjun Nair": encryptJson({
        ...emptyHealthRecord(),
        heightCm: "172", weightKg: "81", bloodGroup: "A+",
        hasHealthIssues: true, healthIssues: "Chronic lower-back pain, stress-induced insomnia",
        medications: "Prescribed physiotherapy, melatonin 3mg",
        heartDisease: { flag: false, detail: "" },
        allergies: ["Pollen"], allergyDetails: "Seasonal rhinitis",
        substanceReliance: ["Caffeine"],
        purposeOfVisit: "Deep detox and pain management",
        dietNotes: "No dietary restrictions. Prefers vegetarian.",
      }),
    };

    const hd = healthData[s.fullName];
    if (hd) {
      await prisma.healthProfile.upsert({
        where: { guestId: guest.id },
        update: {},
        create: { guestId: guest.id, encryptedData: hd.ciphertext, iv: hd.iv, authTag: hd.authTag },
      });
    }

    // Memberships for returning guests
    if (s.fullName === "Meera Krishnan") {
      await prisma.membership.upsert({
        where: { id: "mem-meera" },
        update: {},
        create: {
          id: "mem-meera",
          guestId: guest.id,
          planName: "Annual Wellness Pass",
          startDate: daysAgo(120),
          expiryDate: daysFrom(245),
          creditsTotal: 12,
          creditsUsed: 3,
          discountPct: 15,
          status: "active",
        },
      });
    }
    if (s.fullName === "Karan Malhotra") {
      await prisma.membership.upsert({
        where: { id: "mem-karan" },
        update: {},
        create: {
          id: "mem-karan",
          guestId: guest.id,
          planName: "Corporate Wellness Partner",
          startDate: daysAgo(60),
          expiryDate: daysFrom(305),
          creditsTotal: 6,
          creditsUsed: 2,
          discountPct: 10,
          status: "active",
        },
      });
    }

    const enquiry = await prisma.enquiry.create({
      data: {
        guestId: guest.id,
        stage: s.stage,
        source: s.source,
        assignedToSub: s.assignee?.sub,
        assignedToName: s.assignee?.name,
        isReturningFlag: s.isReturning ?? false,
        quotedPriceINR: s.quotedPriceINR,
        packageId: s.source === "phone" ? day.id : residential.id,
        needsAttention: s.needsAttention ?? false,
        tags: mergeLeadTags(
          s.tags,
          { dateOfBirth: dob, isReturning: s.isReturning ?? false },
          { source: s.source, isReturningFlag: s.isReturning ?? false },
        ),
        lastActivityAt: new Date(),
      },
    });

    enquiryMap[s.fullName] = { enquiryId: enquiry.id, guestId: guest.id };

    // Creation activity
    await prisma.activity.create({
      data: {
        enquiryId: enquiry.id,
        guestId: guest.id,
        actorSub: s.assignee?.sub ?? "system",
        actorRole: "system",
        actorName: s.assignee?.name ?? "System",
        actionType: "created",
        metadata: { source: s.source },
      },
    });

    // Profile note (all stages except new_lead)
    if (s.stage !== "new_lead") {
      await prisma.note.create({
        data: {
          enquiryId: enquiry.id,
          authorSub: s.assignee?.sub ?? "system",
          authorName: s.assignee?.name ?? "System",
          body: `Lead profiled. Stage: ${s.stage}.`,
        },
      });
    }

    // Attention reason note
    if (s.attentionReason) {
      await prisma.note.create({
        data: {
          enquiryId: enquiry.id,
          authorSub: "inbound",
          authorName: "System",
          body: s.attentionReason,
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Tasks — visible in the "All staff" follow-up view
  // ---------------------------------------------------------------------------
  // Priya Menon (RNR) — full 2-2-2 cadence, first one overdue
  const priya = enquiryMap["Priya Menon"];
  await prisma.task.createMany({
    data: [
      {
        enquiryId: priya.enquiryId,
        title: "Follow-up call (1/3) — within 2 hours",
        dueAt: hoursAgo(46),       // overdue — she's been in RNR for 2 days
        status: "open",
        assignedToSub: STAFF.reception.sub,
        createdBy: STAFF.reception.sub,
      },
      {
        enquiryId: priya.enquiryId,
        title: "Follow-up call (2/3) — after 2 days",
        dueAt: hoursFrom(2),       // due very soon
        status: "open",
        assignedToSub: STAFF.reception.sub,
        createdBy: STAFF.reception.sub,
      },
      {
        enquiryId: priya.enquiryId,
        title: "Follow-up call (3/3) — after 2 weeks",
        dueAt: daysFrom(12),
        status: "open",
        assignedToSub: STAFF.reception.sub,
        createdBy: STAFF.reception.sub,
      },
    ],
  });

  // Vikram Shah (needsAttention) — outstanding task for Riya
  const vikram = enquiryMap["Vikram Shah"];
  await prisma.task.create({
    data: {
      enquiryId: vikram.enquiryId,
      title: "Send detailed programme brochure and pricing PDF",
      dueAt: hoursAgo(3),          // overdue — client is waiting
      status: "open",
      assignedToSub: STAFF.reception.sub,
      createdBy: STAFF.manager.sub,
    },
  });

  // Sneha Iyer (pricing_shared, needsAttention) — manager needs to revise quote
  const sneha = enquiryMap["Sneha Iyer"];
  await prisma.task.create({
    data: {
      enquiryId: sneha.enquiryId,
      title: "Send revised quote with doctor consultation included",
      dueAt: hoursFrom(4),
      status: "open",
      assignedToSub: STAFF.manager.sub,
      createdBy: STAFF.manager.sub,
    },
  });

  // Rahul Gupta (qualified) — manager to schedule doctor call
  const rahul = enquiryMap["Rahul Gupta"];
  await prisma.task.createMany({
    data: [
      {
        enquiryId: rahul.enquiryId,
        title: "Schedule online doctor consultation call",
        dueAt: daysFrom(1),
        status: "open",
        assignedToSub: STAFF.manager.sub,
        createdBy: STAFF.manager.sub,
      },
      {
        enquiryId: rahul.enquiryId,
        title: "Share Ayurvedic intake form with guest",
        dueAt: daysFrom(2),
        status: "open",
        assignedToSub: STAFF.reception.sub,
        createdBy: STAFF.manager.sub,
      },
    ],
  });

  // Arjun Nair (doctor_consultation) — admin confirms logistics
  const arjun = enquiryMap["Arjun Nair"];
  await prisma.task.createMany({
    data: [
      {
        enquiryId: arjun.enquiryId,
        title: "Collect advance payment confirmation (50%)",
        dueAt: daysFrom(2),
        status: "open",
        assignedToSub: STAFF.reception.sub,
        createdBy: STAFF.admin.sub,
      },
      {
        enquiryId: arjun.enquiryId,
        title: "Confirm room preference and dietary requirements",
        dueAt: daysFrom(3),
        status: "open",
        assignedToSub: STAFF.reception.sub,
        createdBy: STAFF.manager.sub,
      },
    ],
  });

  // Meera Krishnan (booking_confirmed, returning, needsAttention)
  const meera = enquiryMap["Meera Krishnan"];
  await prisma.task.create({
    data: {
      enquiryId: meera.enquiryId,
      title: "Coordinate room preferences and airport pickup for check-in",
      dueAt: daysFrom(1),
      status: "open",
      assignedToSub: STAFF.manager.sub,
      createdBy: STAFF.admin.sub,
    },
  });

  // Karan Malhotra (converted) — completed feedback task
  const karan = enquiryMap["Karan Malhotra"];
  await prisma.task.createMany({
    data: [
      {
        enquiryId: karan.enquiryId,
        title: "Send post-stay feedback and review link",
        dueAt: daysAgo(3),
        status: "done",
        assignedToSub: STAFF.manager.sub,
        createdBy: STAFF.manager.sub,
      },
      {
        enquiryId: karan.enquiryId,
        title: "Issue referral code for next visit (loyalty programme)",
        dueAt: daysAgo(1),
        status: "done",
        assignedToSub: STAFF.reception.sub,
        createdBy: STAFF.manager.sub,
      },
    ],
  });

  // ---------------------------------------------------------------------------
  // Email conversations (Messages)
  // ---------------------------------------------------------------------------

  // Vikram Shah — outbound intro + inbound reply (triggers needsAttention)
  await prisma.message.createMany({
    data: [
      {
        guestId: vikram.guestId,
        enquiryId: vikram.enquiryId,
        mailboxId: "sales",
        channel: "email",
        direction: "outbound",
        subject: "Welcome to Trē Wellness — Your Personalised Retreat Awaits",
        body: "Dear Vikram,\n\nThank you for reaching out to us via our website. I am delighted to introduce you to Trē Wellness Centre.\n\nWe offer a range of evidence-backed Ayurvedic programmes designed specifically for busy professionals managing stress. Our signature 7-Day Residential Detox has helped hundreds of guests reclaim their vitality.\n\nI would love to schedule a brief call at your convenience to understand your wellness goals better and recommend the right programme.\n\nWarm regards,\nRiya Reception\nTrē Wellness",
        fromEmail: "sales@trewellness.com",
        toEmail: "vikram@example.com",
        messageId: "<out-vikram-001@trewellness.com>",
        status: "delivered",
        createdAt: daysAgo(3),
      },
      {
        guestId: vikram.guestId,
        enquiryId: vikram.enquiryId,
        mailboxId: "sales",
        channel: "email",
        direction: "inbound",
        subject: "Re: Welcome to Trē Wellness — Your Personalised Retreat Awaits",
        body: "Hi Riya,\n\nThank you for your prompt response. I am definitely interested in the 7-Day Residential Detox. Could you please send me a detailed overview of what the programme includes and the pricing? I would also like to know if there are any upcoming batches in July.\n\nLooking forward to hearing from you.\n\nBest,\nVikram",
        fromEmail: "vikram@example.com",
        toEmail: "sales@trewellness.com",
        messageId: "<in-vikram-002@gmail.com>",
        inReplyTo: "<out-vikram-001@trewellness.com>",
        status: "received",
        needsReview: false,
        createdAt: daysAgo(1),
      },
    ],
  });

  // Sneha Iyer — quote sent + her inbound query (triggers needsAttention)
  await prisma.message.createMany({
    data: [
      {
        guestId: sneha.guestId,
        enquiryId: sneha.enquiryId,
        mailboxId: "sales",
        channel: "email",
        direction: "outbound",
        subject: "Trē Wellness — 7-Day Detox Programme Pricing",
        body: "Dear Sneha,\n\nAs discussed on our call, please find the pricing for the 7-Day Residential Detox below:\n\nBase package: ₹98,000 (twin sharing)\nSingle room supplement: ₹18,000\n\nThis includes all therapies, Ayurvedic meals, accommodation and yoga sessions.\n\nPlease let me know if you have any questions.\n\nWarm regards,\nManish Manager",
        fromEmail: "sales@trewellness.com",
        toEmail: "sneha@example.com",
        messageId: "<out-sneha-001@trewellness.com>",
        status: "delivered",
        createdAt: daysAgo(5),
      },
      {
        guestId: sneha.guestId,
        enquiryId: sneha.enquiryId,
        mailboxId: "sales",
        channel: "email",
        direction: "inbound",
        subject: "Re: Trē Wellness — 7-Day Detox Programme Pricing",
        body: "Hello Manish,\n\nThank you for sending the pricing details. Quick question — does the quoted amount of ₹98,000 include a doctor consultation? I have some pre-existing conditions I would like to discuss with your physician before committing.\n\nAlso, do you offer any early bird pricing for bookings made 2 months in advance?\n\nThanks,\nSneha",
        fromEmail: "sneha@example.com",
        toEmail: "sales@trewellness.com",
        messageId: "<in-sneha-002@gmail.com>",
        inReplyTo: "<out-sneha-001@trewellness.com>",
        status: "received",
        needsReview: false,
        createdAt: hoursAgo(6),
      },
    ],
  });

  // Rahul Gupta — single outbound with intake form
  await prisma.message.create({
    data: {
      guestId: rahul.guestId,
      enquiryId: rahul.enquiryId,
      mailboxId: "sales",
      channel: "email",
      direction: "outbound",
      subject: "Trē Wellness — Next Steps for Your Cardiac Wellness Programme",
      body: "Dear Rahul,\n\nIt was wonderful speaking with you. Based on your wellness goals and health history, I am recommending our 7-Day Residential Detox with a custom cardiac wellness overlay, facilitated by our visiting cardiologist.\n\nI am attaching the Ayurvedic intake form — kindly fill this in before your doctor consultation so our physician can prepare a personalised protocol.\n\nExpected investment: ₹1,26,000 (single occupancy, all-inclusive).\n\nLooking forward to welcoming you.\n\nWarm regards,\nManish Manager",
      fromEmail: "sales@trewellness.com",
      toEmail: "rahul@example.com",
      messageId: "<out-rahul-001@trewellness.com>",
      status: "delivered",
      createdAt: daysAgo(2),
    },
  });

  // Meera Krishnan — booking confirmation + her room preferences email
  await prisma.message.createMany({
    data: [
      {
        guestId: meera.guestId,
        enquiryId: meera.enquiryId,
        mailboxId: "sales",
        channel: "email",
        direction: "outbound",
        subject: "Trē Wellness — Booking Confirmed! 🌿 We look forward to welcoming you",
        body: "Dear Meera,\n\nYour booking for the 7-Day Residential Detox (15–21 July 2026) is confirmed. We are thrilled to welcome you back — this will be your second visit and we will ensure it exceeds the first.\n\nPlease share any changes to your dietary requirements or preferences at your earliest convenience so we can prepare accordingly.\n\nSee you soon,\nManish Manager\nTrē Wellness",
        fromEmail: "sales@trewellness.com",
        toEmail: "meera@example.com",
        messageId: "<out-meera-001@trewellness.com>",
        status: "delivered",
        createdAt: daysAgo(4),
      },
      {
        guestId: meera.guestId,
        enquiryId: meera.enquiryId,
        mailboxId: "sales",
        channel: "email",
        direction: "inbound",
        subject: "Re: Trē Wellness — Booking Confirmed! 🌿",
        body: "Hi Manish,\n\nThank you so much — very excited for the visit! A few things I wanted to confirm ahead of time:\n\n1. I would prefer a garden-facing room if available — it helped tremendously with sleep during my last stay.\n2. I will be arriving from Hyderabad on the afternoon of the 15th (likely 3pm). Would it be possible to arrange an airport pickup?\n3. My low-sodium diet should be on file — please confirm with the kitchen team.\n\nLooking forward to it!\nMeera",
        fromEmail: "meera@example.com",
        toEmail: "sales@trewellness.com",
        messageId: "<in-meera-002@gmail.com>",
        inReplyTo: "<out-meera-001@trewellness.com>",
        status: "received",
        needsReview: false,
        createdAt: hoursAgo(18),
      },
    ],
  });

  // ---------------------------------------------------------------------------
  // Call records — populate the Calls admin page and lead Calls tab
  // ---------------------------------------------------------------------------

  // Rahul Gupta — outbound call (manager reached him, qualified)
  await prisma.call.create({
    data: {
      direction: "outbound",
      status: "completed",
      guestId: rahul.guestId,
      enquiryId: rahul.enquiryId,
      repKeycloakId: STAFF.manager.sub,
      repName: STAFF.manager.name,
      repPhone: STAFF.manager.phone,
      customerPhone: "+919844444444",
      startedAt: daysAgo(3),
      answeredAt: new Date(daysAgo(3).getTime() + 15_000),
      endedAt:   new Date(daysAgo(3).getTime() + 8 * 60_000 + 45_000),
      durationSec: 510,
      tags: ["qualified", "high-intent", "doctor-consult-discussed"],
      notes: "Spoke at length about cardiac history. Interested in the cardiologist overlay. Sent intake form post-call. Strong conversion signal.",
    },
  });

  // Arjun Nair — outbound call (reception, post doctor consult)
  await prisma.call.create({
    data: {
      direction: "outbound",
      status: "completed",
      guestId: arjun.guestId,
      enquiryId: arjun.enquiryId,
      repKeycloakId: STAFF.reception.sub,
      repName: STAFF.reception.name,
      repPhone: STAFF.reception.phone,
      customerPhone: "+919866666666",
      startedAt: daysAgo(1),
      answeredAt: new Date(daysAgo(1).getTime() + 12_000),
      endedAt:   new Date(daysAgo(1).getTime() + 6 * 60_000 + 20_000),
      durationSec: 368,
      tags: ["doctor-ready", "payment-pending"],
      notes: "Doctor consultation completed. Guest satisfied with the Ayurvedic protocol. Awaiting 50% advance. Confirmed arrival for 10 July.",
    },
  });

  // Priya Menon — outbound call (went to RNR — no answer)
  await prisma.call.create({
    data: {
      direction: "outbound",
      status: "no_answer",
      guestId: priya.guestId,
      enquiryId: priya.enquiryId,
      repKeycloakId: STAFF.reception.sub,
      repName: STAFF.reception.name,
      repPhone: STAFF.reception.phone,
      customerPhone: "+919833333333",
      startedAt: daysAgo(2),
      endedAt: new Date(daysAgo(2).getTime() + 30_000),
      durationSec: 0,
      tags: ["rnr"],
      notes: "Called twice. No answer. WhatsApp message sent as backup.",
    },
  });

  // Karan Malhotra — inbound call (converted returning guest called in)
  await prisma.call.create({
    data: {
      direction: "inbound",
      status: "completed",
      guestId: karan.guestId,
      enquiryId: karan.enquiryId,
      repKeycloakId: STAFF.manager.sub,
      repName: STAFF.manager.name,
      repPhone: STAFF.manager.phone,
      customerPhone: "+919888888888",
      startedAt: daysAgo(5),
      answeredAt: new Date(daysAgo(5).getTime() + 8_000),
      endedAt:   new Date(daysAgo(5).getTime() + 4 * 60_000 + 12_000),
      durationSec: 244,
      tags: ["converted", "referral-lead", "loyalty"],
      notes: "Karan called to thank the team post-stay. Mentioned referring two friends. Issued referral code VIP2026.",
    },
  });

  // Sneha Iyer — outbound call (phone source lead, first contact)
  await prisma.call.create({
    data: {
      direction: "outbound",
      status: "completed",
      guestId: sneha.guestId,
      enquiryId: sneha.enquiryId,
      repKeycloakId: STAFF.manager.sub,
      repName: STAFF.manager.name,
      repPhone: STAFF.manager.phone,
      customerPhone: "+919855555555",
      startedAt: daysAgo(6),
      answeredAt: new Date(daysAgo(6).getTime() + 9_000),
      endedAt:   new Date(daysAgo(6).getTime() + 11 * 60_000 + 30_000),
      durationSec: 681,
      tags: ["lifestyle", "pricing-discussed"],
      notes: "Long discovery call. Lifestyle concerns around work-life balance. Shared pricing over call. She will review and revert.",
    },
  });

  // Stage-change activities for a richer timeline
  await prisma.activity.createMany({
    data: [
      {
        enquiryId: vikram.enquiryId, guestId: vikram.guestId,
        actorSub: STAFF.reception.sub, actorRole: "RECEPTION", actorName: STAFF.reception.name,
        actionType: "stage_change", metadata: { from: "new_lead", to: "contacted" },
        createdAt: daysAgo(4),
      },
      {
        enquiryId: rahul.enquiryId, guestId: rahul.guestId,
        actorSub: STAFF.manager.sub, actorRole: "MANAGER", actorName: STAFF.manager.name,
        actionType: "stage_change", metadata: { from: "contacted", to: "qualified" },
        createdAt: daysAgo(3),
      },
      {
        enquiryId: sneha.enquiryId, guestId: sneha.guestId,
        actorSub: STAFF.manager.sub, actorRole: "MANAGER", actorName: STAFF.manager.name,
        actionType: "stage_change", metadata: { from: "qualified", to: "pricing_shared" },
        createdAt: daysAgo(5),
      },
      {
        enquiryId: arjun.enquiryId, guestId: arjun.guestId,
        actorSub: STAFF.reception.sub, actorRole: "RECEPTION", actorName: STAFF.reception.name,
        actionType: "stage_change", metadata: { from: "pricing_shared", to: "doctor_consultation" },
        createdAt: daysAgo(2),
      },
      {
        enquiryId: meera.enquiryId, guestId: meera.guestId,
        actorSub: STAFF.manager.sub, actorRole: "MANAGER", actorName: STAFF.manager.name,
        actionType: "stage_change", metadata: { from: "doctor_consultation", to: "booking_confirmed" },
        createdAt: daysAgo(5),
      },
      {
        enquiryId: karan.enquiryId, guestId: karan.guestId,
        actorSub: STAFF.manager.sub, actorRole: "MANAGER", actorName: STAFF.manager.name,
        actionType: "stage_change", metadata: { from: "booking_confirmed", to: "converted" },
        createdAt: daysAgo(10),
      },
    ],
  });

  // Additional notes for richer activity timelines
  await prisma.note.createMany({
    data: [
      {
        enquiryId: rahul.enquiryId,
        authorSub: STAFF.manager.sub, authorName: STAFF.manager.name,
        body: "Spoke with Rahul for 8 min. Very motivated to address cardiac health. Family history of heart disease. Recommended our cardiologist overlay package. Sending intake form.",
        createdAt: daysAgo(3),
      },
      {
        enquiryId: arjun.enquiryId,
        authorSub: STAFF.reception.sub, authorName: STAFF.reception.name,
        body: "Doctor consultation completed via video call — 45 mins. Dr Krishnamurthy recommended Panchakarma + back pain protocol. Guest impressed. Awaiting payment.",
        createdAt: daysAgo(1),
      },
      {
        enquiryId: meera.enquiryId,
        authorSub: STAFF.manager.sub, authorName: STAFF.manager.name,
        body: "Returning guest — VIP treatment. Last visit was exceptional (her words). Ensure garden-facing room and low-sodium dietary preference confirmed with kitchen before arrival.",
        createdAt: daysAgo(4),
      },
      {
        enquiryId: karan.enquiryId,
        authorSub: STAFF.manager.sub, authorName: STAFF.manager.name,
        body: "Karan completed his 7-day stay. Gave a 5-star review. Has referred two friends — Ankit Sharma (Mumbai) and Deepika Malhotra (Gurugram). Follow up with them.",
        createdAt: daysAgo(8),
      },
    ],
  });

  const enquiryCount = await prisma.enquiry.count();
  const taskCount    = await prisma.task.count();
  const messageCount = await prisma.message.count();
  const callCount    = await prisma.call.count();
  console.log(
    `Done. ${enquiryCount} enquiries · ${taskCount} tasks · ${messageCount} messages · ${callCount} calls across the pipeline.`,
  );
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
