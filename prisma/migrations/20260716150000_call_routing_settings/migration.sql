-- Denormalized role on StaffProfile so the inbound-call webhook can filter
-- eligible reps by role without an unauthenticated Keycloak Admin API call.
-- Synced by keycloak-admin.ts (listUsers/createUser/updateUser); existing
-- rows backfill the next time the Users page loads.
ALTER TABLE "StaffProfile" ADD COLUMN "role" TEXT;

-- Single global row controlling inbound call routing. Defaults to
-- Reception-only; an admin can flip it off from the Users page to fall back
-- to routing across any online staff (the pre-existing behavior).
CREATE TABLE "CallRoutingSettings" (
    "id"            TEXT NOT NULL DEFAULT 'singleton',
    "receptionOnly" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallRoutingSettings_pkey" PRIMARY KEY ("id")
);
