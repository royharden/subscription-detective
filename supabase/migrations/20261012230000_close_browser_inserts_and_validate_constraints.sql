/*
# Close browser INSERTs and replace NOT VALID constraints with validated ones

## Plain-English explanation
The opt-in "Save analysis" button no longer writes to the database from the
browser. It now calls the `save-analysis` Edge Function, which validates and
bounds the payload and inserts with the service role. So the browser roles
(anon, authenticated) lose their last write access: they keep SELECT only.

The previous migration added CHECK constraints as NOT VALID (new rows only).
This migration cleans up existing rows and replaces them with VALIDATED
constraints, so every row in the table satisfies them.

## Changes

### analyses, merchants, drafts
- Drops every policy that is not a SELECT policy (INSERT, UPDATE, DELETE, ALL),
  whatever its name or role. The "Public read ..." SELECT policies stay.
- REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT SELECT TO anon,
  authenticated. No INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER.
- GRANT SELECT, INSERT, DELETE TO service_role (used by save-analysis; DELETE
  is only used to roll back a partially written save).

### Existing rows (fixed where a safe fix exists, otherwise deleted)
- Deleted: rows with a mode, status, status_source or tone the app never
  writes, merchants with an empty display_name, drafts with an empty subject
  or body. Deleting an analysis cascades to its merchants and drafts.
- Fixed: over-long text is truncated (title 200, display_name 200, subject
  500, body 10000); an empty title becomes "Untitled analysis"; an over-long
  question_id, an out-of-range noul or jev_cost_usd, and wrong-typed or
  oversized jsonb values are set to NULL.

### Validated CHECK constraints (same limits as save-analysis)
- analyses_bounded_payload, merchants_bounded_payload, drafts_bounded_payload
  are dropped and re-added WITHOUT "NOT VALID", so they are checked against
  all existing rows as well as new ones.

## Security impact
- The anon key can only read saved analyses; every write goes through an
  Edge Function with verify_jwt, payload limits and a daily cap.
- Browser writes are revoked before the cleanup, and the tables are locked
  for the rest of the migration's transaction, so no row can slip in between
  the cleanup and the constraint validation.
*/

-- Hold the tables until the migration's transaction ends (a DO block so this also runs
-- under autocommit runners; there, step 1 revoking browser writes first closes the gap).
DO $$
BEGIN
  LOCK TABLE public.analyses, public.merchants, public.drafts IN ACCESS EXCLUSIVE MODE;
END $$;

-- 1. Browser roles: SELECT only
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('analyses', 'merchants', 'drafts')
      AND cmd <> 'SELECT'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON analyses, merchants, drafts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON analyses, merchants, drafts TO anon, authenticated;
GRANT SELECT, INSERT, DELETE ON analyses, merchants, drafts TO service_role;

-- Intentionally public single-tenant demo (no sign-in): read-only for browser roles
DROP POLICY IF EXISTS "Public read analyses" ON analyses;
CREATE POLICY "Public read analyses" ON analyses FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "Public read merchants" ON merchants;
CREATE POLICY "Public read merchants" ON merchants FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "Public read drafts" ON drafts;
CREATE POLICY "Public read drafts" ON drafts FOR SELECT TO anon, authenticated USING (true);

-- 2. Drop the NOT VALID constraints from the previous migration
ALTER TABLE analyses DROP CONSTRAINT IF EXISTS analyses_bounded_payload;
ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_bounded_payload;
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_bounded_payload;

-- 3. Fix or delete existing rows that would violate the validated constraints

-- analyses: unknown modes never come from the app -> delete (cascades)
DELETE FROM analyses
WHERE jev_mode NOT IN ('live', 'replay', 'heuristic')
   OR llm_mode NOT IN ('live', 'mock');
UPDATE analyses SET title = 'Untitled analysis' WHERE btrim(title) = '';
UPDATE analyses SET title = left(title, 200) WHERE char_length(title) > 200;
UPDATE analyses SET jev_requests = NULL
WHERE jev_requests IS NOT NULL
  AND (jsonb_typeof(jev_requests) <> 'array' OR octet_length(jev_requests::text) > 65536);
UPDATE analyses SET jev_cost_usd = NULL
WHERE jev_cost_usd IS NOT NULL AND NOT (jev_cost_usd BETWEEN 0 AND 1000000);

-- merchants
DELETE FROM merchants
WHERE status NOT IN ('subscription', 'maybe', 'not_subscription')
   OR status_source NOT IN ('jev', 'heuristic', 'user', 'replay')
   OR btrim(display_name) = '';
UPDATE merchants SET display_name = left(display_name, 200) WHERE char_length(display_name) > 200;
UPDATE merchants SET question_id = NULL WHERE char_length(question_id) > 16;
UPDATE merchants SET noul = NULL WHERE noul IS NOT NULL AND NOT (noul BETWEEN 0 AND 1);
UPDATE merchants SET charges = NULL
WHERE charges IS NOT NULL AND (jsonb_typeof(charges) <> 'array' OR octet_length(charges::text) > 262144);
UPDATE merchants SET cadence = NULL
WHERE cadence IS NOT NULL AND (jsonb_typeof(cadence) <> 'object' OR octet_length(cadence::text) > 4096);
UPDATE merchants SET price_hike = NULL
WHERE price_hike IS NOT NULL AND (jsonb_typeof(price_hike) <> 'object' OR octet_length(price_hike::text) > 4096);
UPDATE merchants SET trial = NULL
WHERE trial IS NOT NULL AND (jsonb_typeof(trial) <> 'object' OR octet_length(trial::text) > 4096);

-- drafts
DELETE FROM drafts
WHERE tone NOT IN ('polite', 'firm', 'refund')
   OR btrim(subject) = ''
   OR btrim(body) = '';
UPDATE drafts SET subject = left(subject, 500) WHERE char_length(subject) > 500;
UPDATE drafts SET body = left(body, 10000) WHERE char_length(body) > 10000;

-- 4. Validated constraints (no NOT VALID: every existing row is checked now)
ALTER TABLE analyses ADD CONSTRAINT analyses_bounded_payload CHECK (
  char_length(title) <= 200
  AND btrim(title) <> ''
  AND jev_mode IN ('live', 'replay', 'heuristic')
  AND llm_mode IN ('live', 'mock')
  AND (jev_requests IS NULL OR (jsonb_typeof(jev_requests) = 'array' AND octet_length(jev_requests::text) <= 65536))
  AND (jev_cost_usd IS NULL OR jev_cost_usd BETWEEN 0 AND 1000000)
);

ALTER TABLE merchants ADD CONSTRAINT merchants_bounded_payload CHECK (
  (question_id IS NULL OR char_length(question_id) <= 16)
  AND char_length(display_name) <= 200
  AND btrim(display_name) <> ''
  AND status IN ('subscription', 'maybe', 'not_subscription')
  AND status_source IN ('jev', 'heuristic', 'user', 'replay')
  AND (noul IS NULL OR noul BETWEEN 0 AND 1)
  AND (charges IS NULL OR (jsonb_typeof(charges) = 'array' AND octet_length(charges::text) <= 262144))
  AND (cadence IS NULL OR (jsonb_typeof(cadence) = 'object' AND octet_length(cadence::text) <= 4096))
  AND (price_hike IS NULL OR (jsonb_typeof(price_hike) = 'object' AND octet_length(price_hike::text) <= 4096))
  AND (trial IS NULL OR (jsonb_typeof(trial) = 'object' AND octet_length(trial::text) <= 4096))
);

ALTER TABLE drafts ADD CONSTRAINT drafts_bounded_payload CHECK (
  tone IN ('polite', 'firm', 'refund')
  AND char_length(subject) <= 500
  AND btrim(subject) <> ''
  AND char_length(body) <= 10000
  AND btrim(body) <> ''
);
