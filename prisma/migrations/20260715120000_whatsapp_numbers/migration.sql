-- WhatsApp numbers connected via Evolution API (one row per instance/number).
-- Message.mailboxId reuses this row's instanceName for whatsapp-channel
-- messages — no FK, kept as a plain string like the existing email mailboxes.

CREATE TABLE "WhatsAppNumber" (
    "id"            TEXT NOT NULL,
    "label"         TEXT NOT NULL,
    "phoneNumber"   TEXT,
    "instanceName"  TEXT NOT NULL,
    "instanceToken" TEXT NOT NULL,
    "status"        TEXT NOT NULL DEFAULT 'pending',
    "isDefault"     BOOLEAN NOT NULL DEFAULT false,
    "createdBy"     TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppNumber_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhatsAppNumber_instanceName_key" ON "WhatsAppNumber"("instanceName");
