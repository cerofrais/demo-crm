import { createEnquiry } from "./enquiry-service";
import { enquiryWebhookSchema } from "./validation";
import { packageTag } from "./lead-tags";

/**
 * Turns an enquiry-form webhook payload into a lead. Shared by the public
 * webhook and the lead sheet check, so a lead the check pushes is created
 * exactly the way the n8n workflow's would have been — same validation, same
 * package tag, same assignment, and the same externalRef de-duplication.
 */
export async function ingestWebhookEnquiry(body: unknown, externalRef: string) {
  const input = enquiryWebhookSchema.parse(body);
  const pkgTag = input.packagePreference ? packageTag(input.packagePreference) : null;
  return createEnquiry(
    {
      ...input,
      note: input.intakeNotes ?? input.message,
      enquiryTags: pkgTag ? [pkgTag] : undefined,
      externalRef,
    },
    null, // inbound: unassigned, picked up on the board
  );
}
