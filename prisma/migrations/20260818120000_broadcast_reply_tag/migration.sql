-- Reply tags: a tag chosen when sending a broadcast (WhatsApp or bulk email)
-- that gets applied to a lead when that guest replies to it.

-- Configured once per WhatsApp broadcast.
ALTER TABLE "BroadcastJob" ADD COLUMN "replyTag" TEXT;

-- Stamped on each outbound message. Bulk email has no job row, so for that
-- channel this is the only place the tag lives.
ALTER TABLE "Message" ADD COLUMN "replyTag" TEXT;

-- Serves the fallback lookup: newest tagged outbound message for one guest.
CREATE INDEX "Message_guestId_replyTag_createdAt_idx"
  ON "Message"("guestId", "replyTag", "createdAt");
