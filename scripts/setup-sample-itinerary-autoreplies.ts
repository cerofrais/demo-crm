/**
 * One-off setup for the "Viewing Sample Itinerary" auto-replies.
 *
 *   • uploads the Trē logo and the two sample-itinerary PDFs as shared
 *     library files (marketing, attached to no guest);
 *   • saves the email footer, with the logo embedded — this applies to EVERY
 *     email the CRM sends from the moment it is saved;
 *   • creates two auto-reply rules keyed on the page the form was sent from.
 *
 * Safe to re-run: a library file already uploaded under the same name and
 * size is reused, and a rule with the same terms is left alone.
 *
 *   npx tsx scripts/setup-sample-itinerary-autoreplies.ts \
 *     --logo=/files/tre-logo.png \
 *     --clinical="/files/Tre Wellness - Sample Itinerary - Clinical Programs.pdf" \
 *     --experience="/files/Tre Wellness - Sample Itinerary - Experience Packages.pdf"
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { prisma } from "../src/lib/prisma";
import { buildStorageKey, putObjectBuffer } from "../src/lib/storage";
import { saveEmailFooter } from "../src/lib/email-footer";
import { createEmailAutoReply } from "../src/lib/email-autoreply";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const LOGO = arg("logo");
const CLINICAL = arg("clinical");
const EXPERIENCE = arg("experience");
if (!LOGO || !CLINICAL || !EXPERIENCE) throw new Error("--logo, --clinical and --experience are all required");

const CATEGORY = "marketing" as const;
const ACTOR = "system";

async function libraryFile(path: string, mimeType: string, filename = basename(path)): Promise<string> {
  const content = readFileSync(path);
  const existing = await prisma.document.findFirst({
    where: { filename, category: CATEGORY, guestId: null, enquiryId: null, sizeBytes: content.length },
    select: { id: true },
  });
  if (existing) {
    console.log(`  reuse   ${filename} (${existing.id})`);
    return existing.id;
  }
  const storageKey = buildStorageKey({ category: CATEGORY, filename });
  await putObjectBuffer(storageKey, content, mimeType);
  const doc = await prisma.document.create({
    data: { category: CATEGORY, filename, mimeType, storageKey, sizeBytes: content.length, uploadedBy: ACTOR },
    select: { id: true },
  });
  console.log(`  upload  ${filename} (${(content.length / 1024 / 1024).toFixed(2)} MB) -> ${doc.id}`);
  return doc.id;
}

const REPLY_SUBJECT = "Trē Wellness - Sample Itinerary";

// The signature is NOT repeated here: the saved footer is appended to every
// outgoing email, so the body ends at "Regards" and the footer supplies the rest.
const REPLY_HTML = [
  "<p>Dear Guest,</p>",
  "<p>Thank you for your enquiry, attached below is the Sample Itinerary you requested. Please feel free to contact us at +91 87126 23060 for any further queries.</p>",
  "<p>If you would like, we set up a quick discovery call or arrange a free consultation with our doctors for more clarity.</p>",
  "<p>We look forward to hearing from you</p>",
  "<p>Regards</p>",
].join("");

const RULES = [
  {
    name: "Experience Packages",
    pdf: () => EXPERIENCE!,
    // Host + path, no scheme or trailing slash: matches http and https, with or
    // without the slash, and with tracking parameters appended (real requests
    // arrive as ".../the-resilience-blueprint/?utm_source=ig&...").
    bodyTerms: [
      "trewellness.in/step-into-well-being",
      "trewellness.in/the-resilience-blueprint",
      "trewellness.in/mini-detox",
    ],
  },
  {
    name: "Clinical Programs",
    pdf: () => CLINICAL!,
    bodyTerms: [
      "trewellness.in/disease-management",
      "trewellness.in/preventive-care",
      "trewellness.in/major-detox",
      "trewellness.in/lifestyle-management",
      "trewellness.in/holistic-healing",
    ],
  },
];

async function main() {
  console.log("Library files");
  const logoId = await libraryFile(LOGO!, "image/png", "tre-logo.png");
  const pdfIds: Record<string, string> = {};
  for (const r of RULES) pdfIds[r.name] = await libraryFile(r.pdf(), "application/pdf");

  console.log("\nEmail footer");
  const footer = await saveEmailFooter({
    enabled: true,
    updatedBy: ACTOR,
    html: [
      '<div style="color:#666">--<br><b>The Team at Trē</b></div>',
      `<p><img src="cid:${logoId}" alt="trē" style="max-width:140px"></p>`,
      '<div style="color:#666">An Integrative Wellness Retreat<br>',
      '<a href="https://www.trewellness.in">www.trewellness.in</a><br>',
      'WhatsApp: <a href="https://wa.me/918712623060">+91 87126 23060</a><br>',
      'Phone: <a href="tel:+918712623061">+91 87126 23061</a>, <a href="tel:+918035410003">+91 80354 10003</a></div>',
    ].join(""),
    text: [
      "The Team at Trē",
      "An Integrative Wellness Retreat",
      "www.trewellness.in",
      "WhatsApp: +91 87126 23060",
      "Phone: +91 87126 23061, +91 80354 10003",
    ].join("\n"),
  });
  console.log(`  saved (${footer.html.length} chars html, logo embedded: ${footer.html.includes(`cid:${logoId}`)})`);

  console.log("\nAuto-reply rules");
  for (const r of RULES) {
    const existing = await prisma.emailAutoReply.findFirst({
      where: { subjectTerms: { equals: ["Sample Itinerary"] }, bodyTerms: { equals: r.bodyTerms } },
      select: { id: true },
    });
    if (existing) {
      console.log(`  exists  ${r.name} (${existing.id})`);
      continue;
    }
    const rule = await createEmailAutoReply({
      mailboxId: "sales",
      subjectTerms: ["Sample Itinerary"],
      bodyTerms: r.bodyTerms,
      termMatch: "any",
      subject: REPLY_SUBJECT,
      replyText: REPLY_HTML,
      attachmentDocumentIds: [pdfIds[r.name]],
      createdBy: ACTOR,
    });
    console.log(`  created ${r.name} (${rule.id}) — ${r.bodyTerms.length} pages -> ${basename(r.pdf())}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
