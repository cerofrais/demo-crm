/**
 * Send one test email carrying a footer, WITHOUT saving that footer.
 *
 * The saved footer is applied to every email the CRM sends, so previewing a
 * draft by saving it would put it in front of every guest the moment it was
 * saved. This goes through the same code instead — joinFooter() to attach
 * it, sanitizeEmailHtml() exactly as a save would clean it, and sendEmail()
 * over the real sales mailbox — and passes skipFooter so whatever is saved
 * is not stacked on top.
 *
 * The logo is attached as an inline cid part directly rather than via a
 * Document row, so the test writes nothing to the database or the file store.
 *
 *   npx tsx scripts/send-test-email-footer.ts --to=someone@example.com --logo=/path/logo.png
 */
import { readFileSync } from "node:fs";
import { getMailbox } from "../src/lib/mailboxes";
import { sendEmail } from "../src/lib/mailer";
import { joinFooter } from "../src/lib/email-footer";
import { sanitizeEmailHtml } from "../src/lib/mail-html";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const TO = arg("to");
const LOGO = arg("logo");
if (!TO) throw new Error("--to is required");

const LOGO_CID = "tre-footer-logo";

const footerHtml = sanitizeEmailHtml(`
<div style="color:#666">--<br><b>The Team at Trē</b></div>
${LOGO ? `<p><img src="cid:${LOGO_CID}" alt="trē" style="max-width:140px"></p>` : ""}
<div style="color:#666">
  An Integrative Wellness Retreat<br>
  <a href="https://www.trewellness.in">www.trewellness.in</a><br>
  WhatsApp: <a href="https://wa.me/918712623060">+91 87126 23060</a><br>
  Phone: <a href="tel:+918712623061">+91 87126 23061</a>, <a href="tel:+918035410003">+91 80354 10003</a>
</div>`);

const footerText = [
  "-- ",
  "The Team at Trē",
  "An Integrative Wellness Retreat",
  "www.trewellness.in",
  "WhatsApp: +91 87126 23060",
  "Phone: +91 87126 23061, +91 80354 10003",
].join("\n");

async function main() {
  const mailbox = getMailbox("sales");
  if (!mailbox?.configured) throw new Error("sales mailbox is not configured");

  const body = {
    text: "This is a test of the CRM email footer. The signature below is added by the CRM, not typed here.",
    html: "<p>This is a test of the CRM email footer.</p><p>The signature below is added by the CRM, not typed here.</p>",
  };
  // joinFooter adds its own "-- " separator to the text part.
  const joined = joinFooter(body, { html: footerHtml, text: footerText.replace(/^-- \n/, "") });

  const cidSurvived = footerHtml.includes(`cid:${LOGO_CID}`);
  console.log(`footer html: ${footerHtml.length} chars after sanitize; logo cid kept: ${LOGO ? cidSurvived : "n/a"}`);

  const res = await sendEmail(mailbox, {
    to: TO!,
    subject: "[Test] CRM email footer preview",
    text: joined.text,
    html: joined.html,
    skipFooter: true,
    attachments: LOGO
      ? [{ filename: "tre-logo.png", content: readFileSync(LOGO), contentType: "image/png", cid: LOGO_CID }]
      : [],
  });
  console.log(`sent from ${mailbox.address} to ${TO}: accepted=${res.accepted.join(",")} response="${res.response}"`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
