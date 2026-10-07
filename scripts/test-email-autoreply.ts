/**
 * Push a sample inbound email through the REAL auto-reply matching and
 * rendering, and send the result to a chosen address.
 *
 * Uses the rules, attachments and footer exactly as saved, so what arrives is
 * what a guest would get. Two deliberate differences from a live trigger:
 *   • the reply goes to --to instead of the guest, which is the point of a
 *     test — and --to may be one of our own addresses, which the live path
 *     would (correctly) refuse to answer;
 *   • nothing is written to the database: no lead, no guest, no Message row.
 *
 *   npx tsx scripts/test-email-autoreply.ts --to=ceo@trewellness.in \
 *     --page=https://trewellness.in/step-into-well-being/ [--dry-run]
 */
import { getMailbox, type MailboxId } from "../src/lib/mailboxes";
import { sendEmail } from "../src/lib/mailer";
import { prisma } from "../src/lib/prisma";
import { isWithinSchedule } from "../src/lib/whatsapp-autoreply";
import {
  matchEmailAutoReply,
  mailboxesSharingInbox,
  renderEmailAutoReply,
} from "../src/lib/email-autoreply";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const TO = arg("to");
const PAGE = arg("page");
const SUBJECT = arg("subject") ?? "Viewing Sample Itinerary - Form Submission";
const DRY = process.argv.includes("--dry-run");
if (!PAGE) throw new Error("--page is required");
if (!TO && !DRY) throw new Error("--to is required unless --dry-run");

async function main() {
  // Shaped like the real form mailer's body, with an obviously fake guest.
  const body = [
    `Page URL : ${PAGE}`,
    "Name : Test Guest",
    "Email : test.guest@example.com",
    "Phone : +910000000000",
    "Package : Test",
  ].join("\n");

  const rules = await prisma.emailAutoReply.findMany({
    where: { mailboxId: { in: mailboxesSharingInbox("sales") }, enabled: true },
    orderBy: { createdAt: "asc" },
  });
  const rule = matchEmailAutoReply(
    rules.filter((r) => isWithinSchedule(r.activeFromMin, r.activeToMin)),
    { subject: SUBJECT, body },
  );
  if (!rule) {
    console.log(`No rule matches subject "${SUBJECT}" + page ${PAGE}`);
    process.exit(2);
  }

  const reply = await renderEmailAutoReply(rule, SUBJECT);
  console.log(`matched rule ${rule.id} (terms: ${rule.bodyTerms.join(", ")})`);
  console.log(`subject: ${reply.subject}`);
  for (const a of reply.attachments) {
    console.log(`attachment: ${a.filename} (${(a.content.length / 1024 / 1024).toFixed(2)} MB)`);
  }
  if (DRY) return;

  const mailbox = getMailbox(rule.mailboxId as MailboxId);
  if (!mailbox?.configured) throw new Error(`mailbox ${rule.mailboxId} is not configured`);
  const res = await sendEmail(mailbox, {
    to: TO!,
    subject: reply.subject,
    text: reply.text,
    html: reply.html,
    attachments: reply.attachments,
    headers: { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All" },
  });
  console.log(`sent from ${mailbox.address} to ${TO}: accepted=${res.accepted.join(",")} response="${res.response}"`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
