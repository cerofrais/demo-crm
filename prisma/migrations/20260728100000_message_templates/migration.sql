-- Canned message templates (email/WhatsApp), Admin/Manager managed via the
-- new /message-templates page. Seeded with the client's original 10
-- templates so the switch from hardcoded to DB-backed loses nothing.
CREATE TYPE "MessageTemplateChannel" AS ENUM ('email', 'whatsapp');

CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "channel" "MessageTemplateChannel" NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MessageTemplate_channel_idx" ON "MessageTemplate"("channel");

INSERT INTO "MessageTemplate" ("id", "channel", "name", "subject", "body", "updatedAt") VALUES
('email-intro', 'email', 'Introductory email', 'Welcome to Tre Wellness', $body$Hi {name},

Warm greetings from Tre Wellness 🌿

Thank you for reaching out to us through [source of enquiry] — we're so glad to connect with you. I see that you are interested in our [program name].

We would love to get on a call with you to better understand your wellness goals, preferred duration, dates, and any specific concerns, so we can guide you in the right direction.

Kindly find the attached brochure for your reference.

While we connect, here's a closer look at what we offer:
Website: https://trewellness.in/
Instagram: @tre.wellness (https://www.instagram.com/tre.wellness/)
YouTube: tre wellness (https://www.youtube.com/@trewellness)

Looking forward to hearing from you ✨

Warm regards,
{rep_name}
📞 {rep_phone}
Team Tre Wellness$body$, CURRENT_TIMESTAMP),

('email-followup-no-response', 'email', 'Follow-up — no response', 'Quick Follow-Up from Tre Wellness', $body$Hi {name},

I hope you're doing well.

Just checking in — I wanted to see if you had a chance to go through my previous message.

If you're still exploring, we can set up a quick discovery call or arrange a call with our doctor to help you get more clarity on your wellness goals and what could work best for you.

Please let me know a convenient time, and I'll set it up for you 😊

Warm regards,
{rep_name}
📞 {rep_phone}
Team Tre Wellness$body$, CURRENT_TIMESTAMP),

('email-followup-interested', 'email', 'Follow-up — interested (after call)', 'Next Step: Your Consultation with Our Doctor', $body$Hi {name},

I hope you're doing well.

It was great speaking with you earlier 😊

Just following up to see if you'd like me to go ahead and schedule your call with our doctor. This will help you get more clarity and take the next step confidently.

[Insert package details if they asked for it]

Please let me know a convenient time for you, and I'll set it up right away ✨

Looking forward to hearing from you.

Warm regards,
{rep_name}
📞 {rep_phone}
Team Tre Wellness$body$, CURRENT_TIMESTAMP),

('email-final-no-response', 'email', 'Final follow-up — no response', 'Final Follow-Up from Tre Wellness', $body$Hi {name},

I hope you're doing well.

Just wanted to follow up one last time from our end.

I completely understand things can get busy — if this is still something you'd like to explore, we'd be happy to set up a quick discovery call or a call with our doctor at your convenience.

If not, no worries at all — please feel free to reach out anytime in the future if this becomes relevant for you.

Wishing you good health and well-being ✨

Warm regards,
{rep_name}
📞 {rep_phone}
Team Tre Wellness$body$, CURRENT_TIMESTAMP),

('email-final-was-interested', 'email', 'Final follow-up — was interested, gone quiet', 'Final Follow-Up on Your Wellness Consultation', $body$Hi {name},

I hope you're doing well.

Just checking in one last time from our end.

Since you had shown interest earlier and we shared the details, I wanted to see if you'd still like to go ahead with scheduling your call with our doctor. An update from your end would be appreciated.

I completely understand if now isn't the right time — please feel free to reach out whenever it suits you in the future.

Wishing you the best of health ✨

Warm regards,
{rep_name}
📞 {rep_phone}
Team Tre Wellness$body$, CURRENT_TIMESTAMP),

('wa-intro', 'whatsapp', 'Introductory message', NULL, $body$Hi {name},

Warm greetings from Tre Wellness 🌿

Thank you for reaching out to us through [source of enquiry]. We're so glad to connect with you.

I see that you are interested in our [program name].

We would love to get on a call with you to better understand your wellness goals, preferred duration, dates, and any specific concerns — so we can curate the right experience for you.

While we connect, here's a closer look at what we offer:
Website: https://trewellness.in/
Instagram: @tre.wellness (https://www.instagram.com/tre.wellness/)
YouTube: tre wellness (https://www.youtube.com/@trewellness)

Looking forward to hearing from you ✨

{rep_name}
📞 {rep_phone}
Team Tre Wellness$body$, CURRENT_TIMESTAMP),

('wa-followup-no-response', 'whatsapp', 'Follow-up — no response', NULL, $body$Hi {name},

Just checking in with you — I wanted to see if you had a chance to go through my previous message.

If you're still exploring, we can set up a quick discovery call or we'd be happy to arrange a quick call with our doctor to help you get more clarity on your wellness goals and what could work best for you.

Let me know a convenient time, and I'll set it up for you 😊

{rep_name}
📞 {rep_phone}
Team Tre Wellness$body$, CURRENT_TIMESTAMP),

('wa-followup-interested', 'whatsapp', 'Follow-up — interested (after call)', NULL, $body$Hi {name},

It was great speaking with you earlier 😊

Just following up to see if you'd like me to go ahead and schedule your call with our doctor. This will help you get more clarity and take the next step confidently.

[Insert package details if they ask for it]

Let me know a convenient time for you, and I'll set it up right away ✨

Looking forward to hearing from you,

{rep_name}
📞 {rep_phone}
Team Tre Wellness$body$, CURRENT_TIMESTAMP),

('wa-final-no-response', 'whatsapp', 'Final follow-up — no response', NULL, $body$Hi {name},

Just wanted to follow up one last time from our end.

I completely understand things can get busy — if this is still something you'd like to explore, we'd be happy to set up a quick discovery call or a call with our doctor at your convenience.

If not, no worries at all — feel free to reach out anytime in the future if this becomes relevant for you.

Wishing you good health and well-being ✨

{rep_name}
📞 {rep_phone}
Team Tre Wellness$body$, CURRENT_TIMESTAMP),

('wa-final-was-interested', 'whatsapp', 'Final follow-up — was interested, gone quiet', NULL, $body$Hi {name},

Just checking in one last time from our end.

Since you had shown interest earlier and we shared the details, I wanted to see if you'd still like to go ahead with scheduling your call with our doctor. An update from your end would be appreciated.

I completely understand if now isn't the right time — feel free to reach out whenever it suits you in the future.

Wishing you the best of health ✨

{rep_name}
📞 {rep_phone}
Team Tre Wellness$body$, CURRENT_TIMESTAMP);
