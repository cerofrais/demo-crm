-- New lead source for the n8n-driven Google Sheets ingestion, distinct from
-- generic "website_form" submissions so it can be assignment-controlled
-- separately on the admin lead-assignment page.
ALTER TYPE "LeadSource" ADD VALUE 'google_sheets';
ALTER TYPE "LeadAssignmentCategory" ADD VALUE 'google_sheets';
