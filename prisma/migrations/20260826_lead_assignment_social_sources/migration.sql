-- Website-form, Instagram and Facebook leads previously bypassed
-- LeadAssignmentSettings entirely and fell to the default all-Sales pool, so
-- they could not be restricted to chosen staff the way WhatsApp and email
-- already were. Adding them to the enum lets those channels hold a settings
-- row like any other.
ALTER TYPE "LeadAssignmentCategory" ADD VALUE IF NOT EXISTS 'website_form';
ALTER TYPE "LeadAssignmentCategory" ADD VALUE IF NOT EXISTS 'instagram';
ALTER TYPE "LeadAssignmentCategory" ADD VALUE IF NOT EXISTS 'facebook';
