-- Adds a Mr./Ms. salutation ({salutation} token, resolved from Guest.gender
-- in personalizeTemplate()) to every seeded template's opening line, so
-- "Hi {name}," reads "Hi Mr. Arjun," / "Hi Ms. Divya," / "Hi Karan," (no
-- guessed title when gender is unknown/other).
--
-- Only touches rows whose body still starts with the exact original
-- "Hi {name}," — any template an admin has since edited via /message-templates
-- no longer matches that literal prefix (or was rewritten deliberately) and
-- is left alone rather than clobbered.
UPDATE "MessageTemplate"
SET body = regexp_replace(body, '^Hi \{name\},', 'Hi {salutation}{name},'),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE body LIKE 'Hi {name},%';
