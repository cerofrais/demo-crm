/**
 * Replace the contents of an existing shared library file, keeping its id.
 *
 * Everything that points at a document does so by id — an auto-reply's
 * attachments, the welcome email, an image embedded in a template or the
 * footer — so overwriting the stored object in place updates all of them at
 * once, with nothing to re-link. Uploading a new document instead would leave
 * every one of those still sending the old file.
 *
 * Refuses a file that belongs to a guest or lead: those are records of what
 * a guest sent or was sent, and rewriting them would falsify that history.
 *
 *   npx tsx scripts/replace-library-file.ts --id=<documentId> --file=/path/new.pdf
 */
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma";
import { putObjectBuffer, headObject } from "../src/lib/storage";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const ID = arg("id");
const FILE = arg("file");
if (!ID || !FILE) throw new Error("--id and --file are required");

async function main() {
  const doc = await prisma.document.findUnique({ where: { id: ID! } });
  if (!doc) throw new Error(`document ${ID} not found`);
  if (doc.guestId || doc.enquiryId) throw new Error(`refusing: ${doc.filename} belongs to a guest or lead, not the shared library`);

  const content = readFileSync(FILE!);
  if (!content.length) throw new Error("new file is empty");
  // A PDF must still be a PDF: the stored type, and every client's handling
  // of the attachment, is keyed on it.
  if (doc.mimeType === "application/pdf" && content.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Error("new file is not a PDF, but the document is");
  }

  await putObjectBuffer(doc.storageKey, content, doc.mimeType);
  const head = await headObject(doc.storageKey);
  if (!head || head.contentLength !== content.length) {
    throw new Error(`stored size ${head?.contentLength ?? "unknown"} does not match ${content.length} — not updating the record`);
  }
  await prisma.document.update({ where: { id: doc.id }, data: { sizeBytes: content.length } });

  const mb = (n: number) => (n / 1024 / 1024).toFixed(2);
  console.log(`replaced ${doc.filename}: ${mb(doc.sizeBytes)} MB -> ${mb(content.length)} MB (id ${doc.id} kept)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
