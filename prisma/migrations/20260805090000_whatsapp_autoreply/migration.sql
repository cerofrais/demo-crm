-- WhatsApp auto-reply: one or more triggered/catch-all text replies per
-- connected number, admin-managed via the new /autoreplies page.
CREATE TABLE "AutoReply" (
    "id" TEXT NOT NULL,
    "numberId" TEXT NOT NULL,
    "triggerWord" TEXT,
    "replyText" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoReply_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AutoReply_numberId_enabled_idx" ON "AutoReply"("numberId", "enabled");

ALTER TABLE "AutoReply" ADD CONSTRAINT "AutoReply_numberId_fkey"
    FOREIGN KEY ("numberId") REFERENCES "WhatsAppNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
