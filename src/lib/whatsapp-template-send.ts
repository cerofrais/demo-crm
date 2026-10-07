/**
 * Sending one approved Meta template to one guest, from the lead drawer.
 *
 * The 61 line is Cloud API, and Meta only lets a business open a conversation
 * there with an approved template — free text outside the 24-hour window is
 * rejected. Broadcasts could already send templates; a single reply could not,
 * so re-opening one stalled conversation meant starting a one-person
 * broadcast.
 *
 * The template is re-read from Meta at send time rather than trusted from the
 * page: the client sends a name, and the body text that reaches the guest, the
 * placeholders it needs and whether it is even approved are all facts only
 * Meta holds. It is also what the thread stores, so what a rep reads back is
 * what was actually delivered.
 */
import { shouldUseMarketingApi } from "./broadcast";
import { getObjectBuffer } from "./storage";
import { ApiError } from "./api";
import {
  listMessageTemplates,
  marketingApiEnabled,
  sendTemplateMessage,
  uploadMedia,
  type TemplateSendComponent,
  type WhatsAppTemplate,
} from "./whatsapp-cloud-api";
import { templateBodyParams, templateNeedsHeaderImage } from "./whatsapp-template";
import { checkTemplateValues, fillTemplateBody } from "./whatsapp-template-fill";

export interface TemplateSendInput {
  name: string;
  language: string;
  /** One per placeholder, in the order the template numbers them. */
  params: string[];
  /** The picture a header-image template needs, already stored as a Document
   *  on this guest. Uploaded to Meta at send time: Meta wants its own media
   *  id, and that id is good for one send. */
  headerImage?: { storageKey: string; mimeType: string; filename: string };
}

export interface TemplateSendResult {
  externalId: string | null;
  /** The filled-in text, as the guest will read it — stored on the Message. */
  body: string;
  viaMarketingApi: boolean;
}

export async function sendTemplateToGuest(
  number: { metaPhoneNumberId: string | null; metaAccessToken: string | null; wabaId: string | null; integration: string },
  toPhone: string,
  input: TemplateSendInput,
): Promise<TemplateSendResult> {
  if (number.integration !== "cloud_api" || !number.wabaId || !number.metaAccessToken || !number.metaPhoneNumberId) {
    throw new ApiError("BAD_REQUEST", "Meta templates can only be sent from the official Cloud API number.", 400);
  }

  const templates = await listMessageTemplates(number.wabaId, number.metaAccessToken);
  const template = templates.find((t) => t.name === input.name && t.language === input.language);
  if (!template) throw new ApiError("NOT_FOUND", "That template no longer exists on this number.", 404);
  if (template.status !== "APPROVED") {
    throw new ApiError("BAD_REQUEST", `That template is ${template.status.toLowerCase()}, so Meta will not send it.`, 400);
  }
  // A header-image template carries a picture above its text, and Meta
  // rejects the whole message if it is missing — so the composer asks for one
  // and it is uploaded here, rather than sending the rep somewhere else to do
  // it. The upload returns a media id that is good for this send only.
  const needsImage = templateNeedsHeaderImage(template);
  if (needsImage && !input.headerImage) {
    throw new ApiError("VALIDATION_ERROR", "This template needs a header image — add one and send again.", 400);
  }

  const { names, isNamed } = templateBodyParams(template);
  const problem = checkTemplateValues(names, input.params);
  if (problem) {
    throw new ApiError(
      "VALIDATION_ERROR",
      problem.kind === "tooMany"
        ? "That template takes fewer values than were given."
        : `Fill in every placeholder — {{${problem.name}}} is empty.`,
      400,
    );
  }

  const components: TemplateSendComponent[] = [];
  if (needsImage && input.headerImage) {
    const buffer = await getObjectBuffer(input.headerImage.storageKey);
    const { mediaId } = await uploadMedia(
      number.metaPhoneNumberId,
      number.metaAccessToken,
      buffer,
      input.headerImage.mimeType,
      input.headerImage.filename,
    );
    components.push({ type: "header", parameters: [{ type: "image", image: { id: mediaId } }] });
  }
  if (names.length) {
    components.push({
      type: "body",
      parameters: names.map((name, i) => ({
        type: "text",
        text: input.params[i],
        // Named templates need the name alongside each value; positional ones
        // must not carry it. Meta rejects the mix either way round.
        ...(isNamed ? { parameter_name: name } : {}),
      })),
    });
  }

  const viaMarketingApi = shouldUseMarketingApi(template.category, marketingApiEnabled());
  const { externalId } = await sendTemplateMessage(
    number.metaPhoneNumberId,
    number.metaAccessToken,
    toPhone,
    template.name,
    template.language,
    components,
    viaMarketingApi,
  );

  return { externalId, body: renderedBody(template, names, input.params), viaMarketingApi };
}

function renderedBody(template: WhatsAppTemplate, names: string[], params: string[]): string {
  const body = template.components.find((c) => c.type === "BODY")?.text ?? "";
  return fillTemplateBody(body, names, params).trim() || `(template: ${template.name})`;
}
