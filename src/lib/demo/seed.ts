import type {
  DemoData,
  DemoUser,
  DemoGuest,
  DemoEnquiry,
  DemoNote,
  DemoActivity,
  DemoMessage,
  DemoTask,
  DemoPackage,
  DemoReferral,
  DemoCall,
  DemoTag,
  DemoAiDecision,
  DemoWhatsAppNumber,
  DemoAutoReply,
  DemoMessageTemplate,
  DemoBroadcastJob,
  DemoDocument,
  DemoCampaignRule,
  DemoMarketingReport,
  EnquiryStage,
} from "./types";

/** Tiny deterministic PRNG (mulberry32) so the seed looks the same on every
 *  fresh load instead of reshuffling on each visit. */
function rng(seed: number) {
  let a = seed;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}_${uidCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function pick<T>(r: () => number, arr: T[]): T {
  return arr[Math.floor(r() * arr.length)]!;
}
function pickN<T>(r: () => number, arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && copy.length; i++) {
    out.push(copy.splice(Math.floor(r() * copy.length), 1)[0]!);
  }
  return out;
}
function intBetween(r: () => number, min: number, max: number): number {
  return Math.floor(min + r() * (max - min + 1));
}
function daysAgo(n: number, r: () => number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(intBetween(r, 8, 20), intBetween(r, 0, 59), 0, 0);
  return d.toISOString();
}

const FIRST_NAMES = [
  "Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Sai", "Reyansh", "Krishna", "Ishaan", "Rohan",
  "Ananya", "Diya", "Saanvi", "Aadhya", "Myra", "Ira", "Kiara", "Riya", "Priya", "Sneha",
  "Rahul", "Karthik", "Suresh", "Ramesh", "Vikram", "Manoj", "Anil", "Sunita", "Lakshmi", "Meera",
  "Farhan", "Ayesha", "Zoya", "Imran", "Kabir", "Neha", "Pooja", "Rajesh", "Deepak", "Kavya",
  "Nikhil", "Varun", "Tanvi", "Shreya", "Aisha", "Omar", "Layla", "Sofia", "James", "Emily",
];
const LAST_NAMES = [
  "Reddy", "Rao", "Sharma", "Verma", "Iyer", "Nair", "Menon", "Gupta", "Agarwal", "Kumar",
  "Patel", "Shah", "Chowdhury", "Das", "Mehta", "Kapoor", "Malhotra", "Bhatt", "Pillai", "Naidu",
  "Khan", "Sheikh", "Hussain", "Rahman", "Williams", "Brown", "Fernandes", "D'Souza", "Pinto", "Rego",
];
const CITIES = [
  "Hyderabad", "Bengaluru", "Chennai", "Mumbai", "Pune", "Delhi", "Kolkata", "Vizag",
  "Coimbatore", "Kochi", "Ahmedabad", "Jaipur", "Dubai", "Singapore", "London",
];
const CAMPAIGNS = [
  "Winter Detox 2026", "New Year Wellness Reset", "Weight Management Retreat",
  "Executive Stress Relief", "Panchakarma Special", "Diabetes Care Program",
  "Post-Surgery Recovery", "Immunity Boost Camp", "Ayurveda for Seniors", "Couples Wellness Escape",
];
const SOURCES = ["website_form", "whatsapp", "instagram", "facebook", "referral", "walk_in", "phone", "email", "google_sheets"];
const PREFERRED_CHECKINS = [
  "First week of September", "Mid-October", "Second week of November",
  "Any weekend in December", "After Diwali", "Early January", "Flexible — whenever there's availability",
];
const STAGE_ORDER: EnquiryStage[] = [
  "new_lead", "contacted", "rnr", "qualified", "pricing_shared",
  "doctor_consultation", "payment_received", "booking_confirmed", "converted", "staff", "lost",
];
// Weighted so the pipeline looks like a realistic funnel (most volume early,
// tapering toward the close) rather than a flat spread across columns.
const STAGE_WEIGHTS: Record<EnquiryStage, number> = {
  new_lead: 18, contacted: 15, rnr: 10, qualified: 12, pricing_shared: 10,
  doctor_consultation: 7, payment_received: 5, booking_confirmed: 8, converted: 10, staff: 3, lost: 12, non_leads: 0,
};
function weightedStage(r: () => number): EnquiryStage {
  const total = STAGE_ORDER.reduce((s, k) => s + STAGE_WEIGHTS[k], 0);
  let roll = r() * total;
  for (const s of STAGE_ORDER) {
    roll -= STAGE_WEIGHTS[s];
    if (roll <= 0) return s;
  }
  return "new_lead";
}
const LOST_REASONS = ["Budget too high", "Chose a different centre", "No longer interested", "Unreachable after 6 attempts", "Timing didn't work"];
const THERAPIES = ["Abhyangam", "Shirodhara", "Panchakarma", "Yoga Therapy", "Naturopathy Diet", "Physiotherapy", "Meditation", "Steam Therapy", "Detox Massage"];

function fullName(r: () => number): string {
  return `${pick(r, FIRST_NAMES)} ${pick(r, LAST_NAMES)}`;
}
function phoneNumber(r: () => number): string {
  return `+91 ${intBetween(r, 70000, 99999)}${intBetween(r, 10000, 99999)}`;
}
function emailFor(name: string, r: () => number): string {
  const handle = name.toLowerCase().replace(/[^a-z]/g, ".");
  return `${handle}${intBetween(r, 1, 99)}@${pick(r, ["gmail.com", "yahoo.com", "outlook.com", "icloud.com"])}`;
}

export const DEMO_USERS: DemoUser[] = [
  { sub: "demo-admin", name: "Ananya Krishnan", email: "ananya.krishnan@meridianwellness.demo", role: "ADMIN", phone: "+91 98450 11122", isOnline: true },
  { sub: "demo-manager", name: "Rohit Malhotra", email: "rohit.malhotra@meridianwellness.demo", role: "MANAGER", phone: "+91 98450 22233", isOnline: true },
  { sub: "demo-doctor", name: "Dr. Kavitha Iyer", email: "kavitha.iyer@meridianwellness.demo", role: "DOCTOR", phone: "+91 98450 33344", isOnline: true },
  { sub: "demo-doctoradmin", name: "Dr. Meera Pillai", email: "meera.pillai@meridianwellness.demo", role: "DOCTORADMIN", phone: "+91 98450 99900", isOnline: true },
  { sub: "demo-reception", name: "Fatima Sheikh", email: "fatima.sheikh@meridianwellness.demo", role: "RECEPTION", phone: "+91 98450 44455", isOnline: true },
  { sub: "demo-sales-1", name: "Arjun Nair", email: "arjun.nair@meridianwellness.demo", role: "SALES", phone: "+91 98450 55566", isOnline: true },
  { sub: "demo-sales-2", name: "Sneha Reddy", email: "sneha.reddy@meridianwellness.demo", role: "SALES", phone: "+91 98450 66677", isOnline: false },
  { sub: "demo-staff", name: "Deepak Verma", email: "deepak.verma@meridianwellness.demo", role: "STAFF", phone: "+91 98450 77788", isOnline: true },
  { sub: "demo-viewer", name: "Priya Chowdhury", email: "priya.chowdhury@meridianwellness.demo", role: "VIEWER", phone: "+91 98450 88899", isOnline: false },
];

const SALES_SUBS = ["demo-sales-1", "demo-sales-2", "demo-reception"];

/**
 * Demo email mailboxes. The real app resolves these from the org's configured
 * IMAP/SMTP accounts; here they're a fixed pair so the conversation panel has
 * a From address to attribute outbound mail to, and a mailbox filter to offer.
 */
export const DEMO_MAILBOXES = [
  { id: "sales-inbox", label: "Sales", address: "sales@meridianwellness.demo" },
  { id: "reception-inbox", label: "Front Desk", address: "reception@meridianwellness.demo" },
];

function userName(sub: string | null): string | null {
  return DEMO_USERS.find((u) => u.sub === sub)?.name ?? null;
}

export function generateSeed(): DemoData {
  const r = rng(20260806);
  uidCounter = 0;

  const packages: DemoPackage[] = [
    { id: uid("pkg"), name: "7-Day Panchakarma Detox", category: "residential", durationDays: 7, basePriceINR: 68000, therapies: ["Panchakarma", "Abhyangam", "Steam Therapy"], isActive: true, createdAt: daysAgo(200, r), updatedAt: daysAgo(10, r) },
    { id: uid("pkg"), name: "14-Day Complete Wellness Reset", category: "residential", durationDays: 14, basePriceINR: 125000, therapies: ["Panchakarma", "Yoga Therapy", "Naturopathy Diet", "Meditation"], isActive: true, createdAt: daysAgo(200, r), updatedAt: daysAgo(30, r) },
    { id: uid("pkg"), name: "3-Day Stress Relief Escape", category: "residential", durationDays: 3, basePriceINR: 32000, therapies: ["Abhyangam", "Shirodhara", "Meditation"], isActive: true, createdAt: daysAgo(180, r), updatedAt: daysAgo(5, r) },
    { id: uid("pkg"), name: "Day Spa & Naturopathy", category: "day", durationDays: 1, basePriceINR: 6500, therapies: ["Abhyangam", "Steam Therapy"], isActive: true, createdAt: daysAgo(150, r), updatedAt: daysAgo(60, r) },
    { id: uid("pkg"), name: "Corporate Wellness Day", category: "corporate", durationDays: 1, basePriceINR: 4500, therapies: ["Yoga Therapy", "Meditation"], isActive: true, createdAt: daysAgo(150, r), updatedAt: daysAgo(60, r) },
    { id: uid("pkg"), name: "21-Day Diabetes Reversal", category: "residential", durationDays: 21, basePriceINR: 195000, therapies: ["Naturopathy Diet", "Physiotherapy", "Panchakarma"], isActive: true, createdAt: daysAgo(120, r), updatedAt: daysAgo(20, r) },
    { id: uid("pkg"), name: "Weekend Detox (Legacy)", category: "residential", durationDays: 2, basePriceINR: 18000, therapies: ["Abhyangam"], isActive: false, createdAt: daysAgo(300, r), updatedAt: daysAgo(200, r) },
  ];

  const referrals: DemoReferral[] = Array.from({ length: 10 }).map((_, i) => {
    const max = pick(r, [0, 0, 5, 10, 20]);
    const redemptions = max === 0 ? intBetween(r, 0, 15) : intBetween(r, 0, max);
    return {
      id: uid("ref"),
      code: `WELCOME${(i + 1) * 7}`,
      issuedToGuestId: null,
      campaignLabel: pick(r, CAMPAIGNS),
      maxRedemptions: max,
      redemptionCount: redemptions,
      isActive: r() > 0.15,
      createdAt: daysAgo(intBetween(r, 30, 250), r),
    };
  });

  const whatsappNumbers: DemoWhatsAppNumber[] = [
    { id: uid("wan"), label: "Sales Line", phoneNumber: "+91 98765 10001", instanceName: "sales-primary", status: "connected", isDefault: true, shared: true, integration: "baileys", createdAt: daysAgo(220, r), updatedAt: daysAgo(2, r) },
    { id: uid("wan"), label: "Doctor Consult Line", phoneNumber: "+91 98765 10002", instanceName: "doctor-consult", status: "connected", isDefault: false, shared: true, integration: "cloud_api", createdAt: daysAgo(180, r), updatedAt: daysAgo(4, r) },
    { id: uid("wan"), label: "Reception Front Desk", phoneNumber: "+91 98765 10003", instanceName: "reception-desk", status: "connected", isDefault: false, shared: true, integration: "baileys", createdAt: daysAgo(160, r), updatedAt: daysAgo(1, r) },
    { id: uid("wan"), label: "Marketing Broadcast", phoneNumber: null, instanceName: "marketing-broadcast", status: "pending", isDefault: false, shared: false, integration: "cloud_api", createdAt: daysAgo(3, r), updatedAt: daysAgo(3, r) },
  ];

  const autoReplies: DemoAutoReply[] = [
    { id: uid("ar"), numberId: whatsappNumbers[0]!.id, triggerWord: "price", replyText: "Thanks for your interest! Our packages start at ₹6,500 for a day programme. A member of our team will share full pricing shortly. 🌿", enabled: true, createdAt: daysAgo(90, r) },
    { id: uid("ar"), numberId: whatsappNumbers[0]!.id, triggerWord: null, replyText: "Hi! Thanks for reaching out to Meridian Wellness. Our team will get back to you within a few hours. For urgent queries, call +91 98765 10001.", enabled: true, createdAt: daysAgo(90, r) },
    { id: uid("ar"), numberId: whatsappNumbers[2]!.id, triggerWord: "location", replyText: "We're located at Meridian Wellness Retreat, Shamirpet, Hyderabad. Google Maps: bit.ly/meridian-wellness-map", enabled: true, createdAt: daysAgo(60, r) },
  ];

  const messageTemplates: DemoMessageTemplate[] = [
    { id: uid("tmpl"), channel: "whatsapp", name: "Welcome Message", subject: null, body: "Hi {name}! 👋 Welcome to Meridian Wellness. I'm {rep_name} and I'll be your wellness consultant. How can I help you today?", createdBy: "demo-admin", createdAt: daysAgo(150, r), updatedAt: daysAgo(150, r) },
    { id: uid("tmpl"), channel: "whatsapp", name: "Pricing Follow-up", subject: null, body: "Hi {name}, following up on the pricing details I shared. Any questions I can help clarify? — {rep_name}, {rep_phone}", createdBy: "demo-manager", createdAt: daysAgo(120, r), updatedAt: daysAgo(120, r) },
    { id: uid("tmpl"), channel: "email", name: "Package Brochure", subject: "Your Meridian Wellness Package Details", body: "Dear {name},\n\nThank you for your interest in Meridian Wellness. Please find our package details attached.\n\nWarm regards,\n{rep_name}", createdBy: "demo-admin", createdAt: daysAgo(150, r), updatedAt: daysAgo(90, r) },
    { id: uid("tmpl"), channel: "whatsapp", name: "Booking Confirmation", subject: null, body: "Great news {name}! Your booking is confirmed. Our reception team will share check-in details 48 hours before your arrival. 🎉", createdBy: "demo-reception", createdAt: daysAgo(100, r), updatedAt: daysAgo(100, r) },
    { id: uid("tmpl"), channel: "email", name: "Doctor Consultation Invite", subject: "Schedule Your Free Doctor Consultation", body: "Dear {name},\n\nOur wellness doctor would like to speak with you to recommend the right programme. Please share a convenient time.\n\nBest,\n{rep_name}", createdBy: "demo-doctor", createdAt: daysAgo(80, r), updatedAt: daysAgo(80, r) },
  ];

  const guests: DemoGuest[] = [];
  const enquiries: DemoEnquiry[] = [];
  const notes: DemoNote[] = [];
  const activities: DemoActivity[] = [];
  const messages: DemoMessage[] = [];
  const tasks: DemoTask[] = [];
  const calls: DemoCall[] = [];

  const REMARK_TEMPLATES = [
    "Spoke to the guest, they are interested in the {pkg}.",
    "Sent pricing details over WhatsApp, awaiting response.",
    "Guest requested a callback next week.",
    "Followed up — no response yet, will retry tomorrow.",
    "Guest has a family member joining too, checking availability.",
    "Shared the brochure via email, guest to review with spouse.",
    "Guest asked about payment plans, explained EMI options.",
    "Rescheduled consultation call to next Tuesday.",
  ];

  const N_GUESTS = 68;
  for (let i = 0; i < N_GUESTS; i++) {
    const name = fullName(r);
    const createdAt = daysAgo(intBetween(r, 0, 240), r);
    const isReturning = r() < 0.22;
    const guest: DemoGuest = {
      id: uid("guest"),
      fullName: name,
      phone: r() > 0.05 ? phoneNumber(r) : null,
      email: r() > 0.15 ? emailFor(name, r) : null,
      gender: pick(r, ["male", "female", "male", "female", null]),
      city: pick(r, CITIES),
      ageGroup: pick(r, ["18-30", "31-45", "46-60", "60+"]),
      tags: pickN(r, ["high-intent", "vip", "returning", "budget-sensitive", "corporate"], intBetween(r, 0, 2)),
      isReturning,
      isBlocked: false,
      consentGiven: true,
      referralCodeUsed: r() < 0.12 ? pick(r, referrals).code : null,
      aiReturnScore: isReturning ? intBetween(r, 55, 95) : r() < 0.3 ? intBetween(r, 20, 60) : null,
      aiReturnReason: null,
      aiNextProgram: null,
      createdAt,
      updatedAt: createdAt,
    };
    if (guest.aiReturnScore !== null) {
      guest.aiReturnReason = guest.aiReturnScore > 70
        ? "Completed a programme within the last year and engaged positively with follow-up messages."
        : "Limited engagement since last visit; may need a re-activation campaign.";
      guest.aiNextProgram = pick(r, packages).name;
    }
    guests.push(guest);

    // 1-2 enquiries for returning guests, else 1
    const enquiryCount = isReturning && r() < 0.4 ? 2 : 1;
    for (let e = 0; e < enquiryCount; e++) {
      const stage = weightedStage(r);
      const source = pick(r, SOURCES);
      const assigned = stage === "new_lead" && r() < 0.3 ? null : pick(r, SALES_SUBS);
      const enqCreatedAt = daysAgo(intBetween(r, 0, 200), r);
      const lastActivityAt = daysAgo(intBetween(r, 0, 30), r);
      const pkg = r() > 0.3 ? pick(r, packages) : null;
      const needsAI = ["qualified", "pricing_shared", "doctor_consultation", "payment_received"].includes(stage);

      const enquiry: DemoEnquiry = {
        id: uid("enq"),
        guestId: guest.id,
        stage,
        source,
        assignedToSub: assigned,
        assignedToName: userName(assigned),
        packageId: pkg?.id ?? null,
        referralCodeId: guest.referralCodeUsed ? referrals.find((rf) => rf.code === guest.referralCodeUsed)?.id ?? null : null,
        isReturningFlag: isReturning,
        quotedPriceINR: pkg ? pkg.basePriceINR - (r() < 0.3 ? intBetween(r, 1000, 8000) : 0) : null,
        proposedDates: ["booking_confirmed", "converted"].includes(stage) ? `${intBetween(r, 1, 28)} ${pick(r, ["Sep", "Oct", "Nov", "Dec"])} 2026` : null,
        lostReason: stage === "lost" ? pick(r, LOST_REASONS) : null,
        campaignLabel: r() > 0.25 ? pick(r, CAMPAIGNS) : null,
        intakeNotes: r() < 0.4 ? "Enquired via landing page form — asked about availability this month." : null,
        tags: pickN(r, ["hot-lead", "follow-up-needed", "vip", "price-sensitive", "corporate-referral"], intBetween(r, 0, 2)),
        boardPosition: e,
        needsAttention: r() < 0.15 && !["converted", "lost"].includes(stage),
        aiScore: needsAI || r() < 0.5 ? intBetween(r, 35, 96) : null,
        aiScoreReason: null,
        aiAssist: null,
        aiAssistAt: null,
        rnrProgress: stage === "rnr" ? { done: intBetween(r, 1, 2), total: 3 } : null,
        doctorDecision: stage === "doctor_consultation" && r() < 0.4 ? pick(r, ["accepted", "rejected", "needs_phone_consult"] as const) : null,
        doctorDecisionAt: null,
        doctorDecisionNote: null,
        lostRequestPending: stage !== "lost" && r() < 0.05,
        preferredCheckIn: r() < 0.45 ? pick(r, PREFERRED_CHECKINS) : null,
        // ~7% of leads are archived. Seeded here rather than as a separate
        // pass so the deleted lead keeps the full history (notes, messages,
        // calls, tasks) the Deleted page is built to show.
        deletedAt: r() < 0.07 ? daysAgo(intBetween(r, 1, 40), r) : null,
        lastActivityAt,
        createdAt: enqCreatedAt,
        updatedAt: lastActivityAt,
      };
      if (enquiry.aiScore !== null) {
        enquiry.aiScoreReason = enquiry.aiScore > 70
          ? "High engagement, responded quickly to pricing, and matches our highest-converting demographic for this campaign."
          : enquiry.aiScore > 45
            ? "Moderate engagement — responded to outreach but hasn't confirmed intent to book yet."
            : "Low engagement so far — limited response to follow-up attempts.";
      }
      if (enquiry.doctorDecision) {
        enquiry.doctorDecisionAt = lastActivityAt;
        enquiry.doctorDecisionNote = enquiry.doctorDecision === "accepted"
          ? "Cleared for the programme, no contraindications noted."
          : enquiry.doctorDecision === "rejected"
            ? "Not a fit for residential detox at this time — recommended a day-programme alternative instead."
            : "Needs a phone consult before we proceed — flagged a medication interaction to review.";
      }
      enquiries.push(enquiry);

      // Notes / activity timeline
      const noteCount = intBetween(r, 0, 4);
      for (let n = 0; n < noteCount; n++) {
        const authorSub = pick(r, SALES_SUBS);
        notes.push({
          id: uid("note"),
          enquiryId: enquiry.id,
          authorSub,
          authorName: userName(authorSub) ?? "System",
          authorRole: DEMO_USERS.find((u) => u.sub === authorSub)?.role ?? "SALES",
          body: pick(r, REMARK_TEMPLATES).replace("{pkg}", pkg?.name ?? "programme"),
          createdAt: daysAgo(intBetween(r, 0, 60), r),
        });
      }
      activities.push({
        id: uid("act"),
        enquiryId: enquiry.id,
        guestId: guest.id,
        actorSub: "system",
        actorRole: "system",
        actorName: "System",
        actionType: "created",
        metadata: { source, returning: isReturning },
        createdAt: enqCreatedAt,
      });
      if (assigned) {
        activities.push({
          id: uid("act"),
          enquiryId: enquiry.id,
          guestId: guest.id,
          actorSub: "system",
          actorRole: "system",
          actorName: "Auto-assign",
          actionType: "assign",
          metadata: { to: userName(assigned) },
          createdAt: enqCreatedAt,
        });
      }
      if (stage !== "new_lead") {
        activities.push({
          id: uid("act"),
          enquiryId: enquiry.id,
          guestId: guest.id,
          actorSub: assigned ?? "system",
          actorRole: "SALES",
          actorName: userName(assigned) ?? "System",
          actionType: "stage_change",
          metadata: { from: "new_lead", to: stage },
          createdAt: lastActivityAt,
        });
      }

      // Message thread
      const msgCount = intBetween(r, 0, 5);
      for (let m = 0; m < msgCount; m++) {
        const inbound = m % 2 === 0;
        messages.push({
          id: uid("msg"),
          guestId: guest.id,
          enquiryId: enquiry.id,
          mailboxId: whatsappNumbers[0]!.instanceName,
          channel: "whatsapp",
          direction: inbound ? "inbound" : "outbound",
          subject: null,
          body: inbound
            ? pick(r, ["Hi, I'm interested in your wellness packages.", "What are the dates available?", "Can you share pricing?", "Is this suitable for diabetes?", "Thank you, I'll get back to you."])
            : pick(r, ["Thanks for reaching out! Let me share our packages.", "We have availability from next month.", `Our ${pkg?.name ?? "Wellness Programme"} starts at ₹${(pkg?.basePriceINR ?? 45000).toLocaleString("en-IN")}.`, "Yes, our doctor can review your case first.", "Sounds great, let me know if you have questions!"]),
          bodyHtml: null,
          fromEmail: null,
          toEmail: null,
          status: "delivered",
          needsReview: false,
          fromLabel: inbound ? null : "Sales Line",
          editedAt: null,
          deletedAt: null,
          createdAt: daysAgo(intBetween(r, 0, 45), r),
        });
      }

      // Email thread — only for guests who left an address behind.
      if (guest.email) {
        const mailbox = pick(r, DEMO_MAILBOXES);
        const emailCount = intBetween(r, 0, 3);
        for (let m = 0; m < emailCount; m++) {
          const inbound = m % 2 === 1;
          messages.push({
            id: uid("msg"),
            guestId: guest.id,
            enquiryId: enquiry.id,
            mailboxId: mailbox.id,
            channel: "email",
            direction: inbound ? "inbound" : "outbound",
            subject: inbound
              ? `Re: Your enquiry with Meridian Wellness`
              : pick(r, ["Your enquiry with Meridian Wellness", `${pkg?.name ?? "Wellness Programme"} — details inside`, "Following up on your wellness enquiry"]),
            body: inbound
              ? pick(r, [
                  "Thanks for the details. Could you also share what's included in the daily schedule?",
                  "This looks good. What dates do you have open in the next two months?",
                  "Received, thank you. I'll discuss with my family and revert.",
                  "Do you offer any discount for a couple booking together?",
                ])
              : pick(r, [
                  `Dear ${guest.fullName.split(" ")[0]},\n\nThank you for your interest in Meridian Wellness. I've attached the details for our ${pkg?.name ?? "wellness programmes"} along with current availability.\n\nWarm regards,\nMeridian Wellness Team`,
                  `Dear ${guest.fullName.split(" ")[0]},\n\nFollowing up on our conversation — our doctor is happy to review your case before you commit to a programme. Would a call this week suit you?\n\nWarm regards,\nMeridian Wellness Team`,
                  `Dear ${guest.fullName.split(" ")[0]},\n\nJust checking in on your enquiry. Do let me know if you'd like me to hold a slot for you.\n\nWarm regards,\nMeridian Wellness Team`,
                ]),
            bodyHtml: null,
            fromEmail: inbound ? guest.email : mailbox.address,
            toEmail: inbound ? mailbox.address : guest.email,
            status: "delivered",
            needsReview: false,
            fromLabel: inbound ? null : mailbox.label,
            editedAt: null,
            deletedAt: null,
            attachment: null,
            createdAt: daysAgo(intBetween(r, 0, 45), r),
          });
        }
      }

      // Tasks
      if (r() < 0.35 && stage !== "converted" && stage !== "lost") {
        tasks.push({
          id: uid("task"),
          enquiryId: enquiry.id,
          guestName: name,
          title: pick(r, ["Follow up on pricing", "Call to confirm dates", "Send brochure", "Check in after doctor consult", "Confirm payment received", "Re-engage after RNR"]),
          dueAt: daysAgo(-intBetween(r, 0, 7), r),
          status: r() < 0.7 ? "open" : "done",
          kind: "follow_up",
          approved: null,
          assignedToSub: assigned ?? pick(r, SALES_SUBS),
          createdBy: assigned ?? "demo-manager",
          createdAt: daysAgo(intBetween(r, 0, 20), r),
          updatedAt: daysAgo(intBetween(r, 0, 10), r),
        });
      }
      if (enquiry.doctorDecision === "needs_phone_consult") {
        tasks.push({
          id: uid("task"),
          enquiryId: enquiry.id,
          guestName: name,
          title: "Doctor review — phone consult needed",
          dueAt: daysAgo(-2, r),
          status: "open",
          kind: "doctor_review",
          approved: null,
          assignedToSub: "demo-doctor",
          createdBy: "demo-doctor",
          createdAt: lastActivityAt,
          updatedAt: lastActivityAt,
        });
      }

      // Calls
      if (r() < 0.5) {
        const callCount = intBetween(r, 1, 3);
        for (let c = 0; c < callCount; c++) {
          const direction = r() < 0.6 ? "outbound" : "inbound";
          const rep = pick(r, SALES_SUBS);
          const status = pick(r, ["completed", "completed", "completed", "no_answer", "voicemail"] as const);
          const duration = status === "completed" ? intBetween(r, 45, 620) : 0;
          const startedAt = daysAgo(intBetween(r, 0, 40), r);
          const analyzed = status === "completed" && r() < 0.6;
          calls.push({
            id: uid("call"),
            direction,
            status,
            guestId: guest.id,
            enquiryId: enquiry.id,
            guestName: name,
            repKeycloakId: rep,
            repName: userName(rep),
            repPhone: DEMO_USERS.find((u) => u.sub === rep)?.phone ?? null,
            customerPhone: guest.phone ?? phoneNumber(r),
            startedAt,
            answeredAt: status === "completed" ? startedAt : null,
            endedAt: status === "completed" ? startedAt : null,
            durationSec: duration,
            recordingUrl: status === "completed" ? "#demo-recording" : null,
            tags: status === "completed" ? pickN(r, ["interested", "price-discussion", "follow-up", "objection-handled"], intBetween(r, 0, 2)) : [],
            notes: status === "completed" ? "Discussed programme options and answered pricing questions." : null,
            transcript: analyzed ? `Rep: Hello, this is ${userName(rep)} calling from Meridian Wellness. Guest: Hi, yes I filled the form. Rep: Great, I wanted to check what you're looking for. Guest: I'm looking for a detox programme, maybe a week long. Rep: We have a great 7-day Panchakarma Detox — would you like the pricing? Guest: Yes please.` : null,
            transcriptEnglish: null,
            transcriptLanguage: analyzed ? "en" : null,
            aiSummary: analyzed ? "Guest is interested in a 7-day detox programme and requested pricing. Positive tone, high intent." : null,
            aiScore: analyzed ? intBetween(r, 55, 95) : null,
            aiTags: analyzed ? pickN(r, ["high-intent", "price-sensitive", "needs-follow-up"], 2) : [],
            aiSuggestions: analyzed ? {
              hookLine: "Good opening — greeted the guest by referencing their form submission.",
              explanation: "Explained the programme clearly but could have asked more discovery questions before pitching.",
              professionalism: "Professional and courteous tone throughout the call.",
            } : null,
            aiAnalyzedAt: analyzed ? startedAt : null,
            createdAt: startedAt,
          });
        }
      }
    }
  }

  const tags: DemoTag[] = [
    { id: uid("tag"), value: "high-intent", category: "custom", createdAt: daysAgo(200, r) },
    { id: uid("tag"), value: "vip", category: "custom", createdAt: daysAgo(200, r) },
    { id: uid("tag"), value: "returning", category: "revisit", createdAt: daysAgo(200, r) },
    { id: uid("tag"), value: "budget-sensitive", category: "custom", createdAt: daysAgo(180, r) },
    { id: uid("tag"), value: "corporate", category: "custom", createdAt: daysAgo(180, r) },
    { id: uid("tag"), value: "hot-lead", category: "custom", createdAt: daysAgo(150, r) },
    { id: uid("tag"), value: "follow-up-needed", category: "custom", createdAt: daysAgo(150, r) },
    { id: uid("tag"), value: "price-sensitive", category: "custom", createdAt: daysAgo(150, r) },
    { id: uid("tag"), value: "corporate-referral", category: "source", createdAt: daysAgo(150, r) },
  ];

  // AI decision audit log — one row per analyzed call + a handful of lead-scoring / guest-insight runs.
  const aiDecisions: DemoAiDecision[] = [];
  for (const call of calls.filter((c) => c.aiAnalyzedAt)) {
    aiDecisions.push({
      id: uid("aidec"),
      kind: "call_analysis",
      callId: call.id,
      enquiryId: call.enquiryId,
      guestId: call.guestId,
      subjectLabel: call.guestName,
      provider: "ollama",
      model: "gemma3:latest",
      promptSystem: "You are a sales-call quality analyst for a wellness retreat CRM. Score the call, summarize it, and suggest coaching tips.",
      promptUser: `Transcript:\n${call.transcript}`,
      output: { summary: call.aiSummary, score: call.aiScore, tags: call.aiTags, suggestions: call.aiSuggestions },
      success: true,
      triggeredBy: "pipeline",
      triggeredByName: "Background pipeline",
      createdAt: call.aiAnalyzedAt!,
    });
  }
  for (const enq of enquiries.filter((e) => e.aiScore !== null).slice(0, 25)) {
    const guest = guests.find((g) => g.id === enq.guestId)!;
    aiDecisions.push({
      id: uid("aidec"),
      kind: "lead_scoring",
      callId: null,
      enquiryId: enq.id,
      guestId: enq.guestId,
      subjectLabel: guest.fullName,
      provider: "ollama",
      model: "gemma3:latest",
      promptSystem: "You are a lead-scoring assistant. Given the enquiry's engagement history, output a 0-100 conversion likelihood score with a short reason.",
      promptUser: `Stage: ${enq.stage}. Source: ${enq.source}. Messages exchanged: ${messages.filter((m) => m.enquiryId === enq.id).length}. Campaign: ${enq.campaignLabel ?? "none"}.`,
      output: { score: enq.aiScore, reason: enq.aiScoreReason },
      success: true,
      triggeredBy: "pipeline",
      triggeredByName: "Background pipeline",
      createdAt: enq.lastActivityAt,
    });
  }
  aiDecisions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const broadcastJobs: DemoBroadcastJob[] = [
    { id: uid("bcast"), status: "completed", message: "🌿 New Year, new you! Book our Winter Detox programme this month and save 10%.", numberId: whatsappNumbers[0]!.id, totalCount: 142, sentCount: 142, failedCount: 3, createdAt: daysAgo(20, r), completedAt: daysAgo(20, r), deletedAt: null },
    { id: uid("bcast"), status: "completed", message: "Reminder: our Corporate Wellness Day slots for next month are filling up fast!", numberId: whatsappNumbers[0]!.id, totalCount: 58, sentCount: 58, failedCount: 0, createdAt: daysAgo(8, r), completedAt: daysAgo(8, r), deletedAt: null },
    { id: uid("bcast"), status: "running", message: "🎉 Diwali Special: 14-Day Wellness Reset at a special festive price.", numberId: whatsappNumbers[0]!.id, totalCount: 210, sentCount: 134, failedCount: 2, createdAt: daysAgo(0, r), completedAt: null, deletedAt: null },
  ];

  // ---- Resources library ---------------------------------------------------
  // A mix of general collateral (what the composer's attachment picker offers
  // for reuse) and a few guest-scoped files, so the Documents tab isn't empty.
  const documents: DemoDocument[] = [
    { id: uid("doc"), filename: "Meridian-Wellness-Brochure-2026.pdf", mimeType: "application/pdf", sizeBytes: 2_845_120, category: "marketing", guestId: null, enquiryId: null, uploadedBySub: "demo-admin", createdAt: daysAgo(120, r) },
    { id: uid("doc"), filename: "Package-Pricing-Sheet.pdf", mimeType: "application/pdf", sizeBytes: 486_300, category: "marketing", guestId: null, enquiryId: null, uploadedBySub: "demo-manager", createdAt: daysAgo(95, r) },
    { id: uid("doc"), filename: "Panchakarma-Programme-Schedule.pdf", mimeType: "application/pdf", sizeBytes: 731_400, category: "operational", guestId: null, enquiryId: null, uploadedBySub: "demo-manager", createdAt: daysAgo(88, r) },
    { id: uid("doc"), filename: "Daily-Diet-Plan-Sample.pdf", mimeType: "application/pdf", sizeBytes: 312_900, category: "operational", guestId: null, enquiryId: null, uploadedBySub: "demo-doctor", createdAt: daysAgo(70, r) },
    { id: uid("doc"), filename: "Retreat-Photos-Gallery.jpg", mimeType: "image/jpeg", sizeBytes: 1_204_800, category: "marketing", guestId: null, enquiryId: null, uploadedBySub: "demo-admin", createdAt: daysAgo(64, r) },
    { id: uid("doc"), filename: "Consent-Form-Template.pdf", mimeType: "application/pdf", sizeBytes: 198_700, category: "consent", guestId: null, enquiryId: null, uploadedBySub: "demo-doctor", createdAt: daysAgo(150, r) },
    { id: uid("doc"), filename: "Travel-and-Directions.pdf", mimeType: "application/pdf", sizeBytes: 254_100, category: "operational", guestId: null, enquiryId: null, uploadedBySub: "demo-reception", createdAt: daysAgo(45, r) },
    { id: uid("doc"), filename: "Corporate-Wellness-Deck.pdf", mimeType: "application/pdf", sizeBytes: 3_920_400, category: "marketing", guestId: null, enquiryId: null, uploadedBySub: "demo-manager", createdAt: daysAgo(30, r) },
  ];
  // A handful attached to real guests, so per-guest document lists have content.
  for (const g of guests.filter(() => r() < 0.12).slice(0, 10)) {
    documents.push({
      id: uid("doc"),
      filename: pick(r, ["Blood-Report.pdf", "Previous-Prescription.pdf", "ID-Proof.jpg", "Signed-Consent.pdf"]),
      mimeType: r() < 0.3 ? "image/jpeg" : "application/pdf",
      sizeBytes: intBetween(r, 120_000, 2_400_000),
      category: pick(r, ["medical", "consent", "operational"] as const),
      guestId: g.id,
      enquiryId: enquiries.find((e) => e.guestId === g.id)?.id ?? null,
      uploadedBySub: pick(r, SALES_SUBS),
      createdAt: daysAgo(intBetween(r, 1, 60), r),
    });
  }

  // ---- Campaign-based lead assignment --------------------------------------
  const campaignRules: DemoCampaignRule[] = [
    { campaignSlug: "winter-detox-2026", campaignLabel: "Winter Detox 2026", strategy: "round_robin", eligibleSubs: ["demo-sales-1", "demo-sales-2"] },
    { campaignSlug: "executive-stress-relief", campaignLabel: "Executive Stress Relief", strategy: "least_busy", eligibleSubs: ["demo-sales-1", "demo-reception"] },
  ];

  // ---- Marketing reports ---------------------------------------------------
  // One daily CSV per day for the last week, plus a custom-range export.
  const marketingReports: DemoMarketingReport[] = Array.from({ length: 7 }).map((_, i) => {
    const day = daysAgo(i + 1, r).slice(0, 10);
    const rows = intBetween(r, 3, 24);
    return {
      id: uid("mrep"),
      reportDate: day,
      rangeStart: `${day}T00:00:00.000Z`,
      rangeEnd: `${day}T23:59:59.999Z`,
      custom: false,
      filename: `meridian-marketing-${day}.csv`,
      rowCount: rows,
      sizeBytes: rows * 640 + intBetween(r, 200, 900),
      generatedAt: daysAgo(i, r),
      emailedAt: i > 0 ? daysAgo(i, r) : null,
      emailedTo: i > 0 ? "ceo@meridianwellness.demo" : null,
      emailError: null,
    };
  });
  marketingReports.push({
    id: uid("mrep"),
    reportDate: null,
    rangeStart: daysAgo(30, r),
    rangeEnd: daysAgo(1, r),
    custom: true,
    filename: "meridian-marketing-custom-range.csv",
    rowCount: 148,
    sizeBytes: 96_400,
    generatedAt: daysAgo(1, r),
    emailedAt: null,
    emailedTo: null,
    emailError: null,
  });

  return {
    version: 3,
    users: DEMO_USERS,
    guests,
    enquiries,
    notes,
    activities,
    messages,
    tasks,
    packages,
    referrals,
    calls,
    tags,
    aiDecisions,
    whatsappNumbers,
    autoReplies,
    messageTemplates,
    broadcastJobs,
    documents,
    campaignRules,
    marketingReports,
  };
}
