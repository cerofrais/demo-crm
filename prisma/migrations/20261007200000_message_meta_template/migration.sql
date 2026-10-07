-- Which approved template a message was sent as, beside the words it said.
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "metaTemplateName" TEXT;

-- Backfill from the broadcast each message belongs to.
UPDATE "Message" m
SET "metaTemplateName" = j."templateName"
FROM "BroadcastJob" j
WHERE j.id = m."broadcastJobId" AND j."templateName" IS NOT NULL AND m."metaTemplateName" IS NULL;

-- And the few that still carry the name in their body because nothing else
-- recorded it (no broadcast job): take it from there, leaving the body alone.
UPDATE "Message"
SET "metaTemplateName" = substring(body from '^\[template: ([^\]]+)\]')
WHERE "metaTemplateName" IS NULL AND body LIKE '[template:%';
