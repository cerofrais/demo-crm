-- "Returning guest" now means the guest has actually stayed with us (see
-- src/lib/guest-visits.ts), not merely that a second enquiry matched their
-- phone or email. Recompute the stored flags and the `revisit` tag to match.

-- A guest has visited when one of their leads reached Booking Confirmed or
-- Converted, or they were bulk-imported from a past-stay list.
UPDATE "Guest" g
SET "isReturning" = x.visited
FROM (
  SELECT g2.id,
    EXISTS (
      SELECT 1 FROM "Enquiry" e
      WHERE e."guestId" = g2.id AND e."deletedAt" IS NULL AND e.stage IN ('booking_confirmed', 'converted')
    )
    OR EXISTS (SELECT 1 FROM unnest(g2.tags) t WHERE t ~ '(^|-)stay-guests(-|$)') AS visited
  FROM "Guest" g2
) x
WHERE g.id = x.id AND g."isReturning" IS DISTINCT FROM x.visited;

-- A lead is a revisit when the guest had stayed BEFORE it was created: a
-- past-stay import, or an earlier lead of theirs that was booked.
UPDATE "Enquiry" e
SET "isReturningFlag" = x.visited
FROM (
  SELECT e2.id,
    EXISTS (
      SELECT 1 FROM "Guest" g, unnest(g.tags) t
      WHERE g.id = e2."guestId" AND t ~ '(^|-)stay-guests(-|$)'
    )
    OR EXISTS (
      SELECT 1 FROM "Enquiry" p
      WHERE p."guestId" = e2."guestId" AND p.id <> e2.id AND p."deletedAt" IS NULL
        AND p.stage IN ('booking_confirmed', 'converted') AND p."createdAt" < e2."createdAt"
    ) AS visited
  FROM "Enquiry" e2
) x
WHERE e.id = x.id AND e."isReturningFlag" IS DISTINCT FROM x.visited;

-- The stored `revisit` system tag follows the lead's flag.
UPDATE "Enquiry" SET tags = array_remove(tags, 'revisit')
WHERE NOT "isReturningFlag" AND 'revisit' = ANY(tags);

UPDATE "Enquiry" SET tags = ARRAY['revisit'] || tags
WHERE "isReturningFlag" AND NOT ('revisit' = ANY(tags));
