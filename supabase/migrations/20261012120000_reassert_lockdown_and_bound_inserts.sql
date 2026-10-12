/*
# Re-assert the counter lockdown and bound browser INSERT payloads

## Plain-English explanation
Earlier migrations locked down the daily-cap counter and removed UPDATE/DELETE
from the browser. This migration re-applies that end state idempotently (so it
holds even if a policy or grant was changed by hand in the dashboard) and adds
size/enum limits to the only remaining browser writes: the opt-in
"Save analysis" INSERTs on analyses, merchants and drafts.

## Changes

### function_usage (daily cap counter)
- RLS stays ENABLED; every policy on the table is dropped, so no anon or
  authenticated policy exists.
- REVOKE ALL ON function_usage FROM PUBLIC, anon, authenticated.

### upsert_function_usage(text, date)
- Keeps SECURITY DEFINER and the fixed search_path = public (re-asserted).
- REVOKE EXECUTE FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role.

### analyses, merchants, drafts (app data)
- Drops every UPDATE, DELETE and FOR ALL policy, whatever its name or role.
- Table privileges for anon/authenticated reset to SELECT + INSERT only
  (INSERT is what the opt-in "Save analysis" button needs; no UPDATE, DELETE,
  TRUNCATE, REFERENCES or TRIGGER).
- Re-creates the SELECT and INSERT policies the UI relies on.
- Adds CHECK constraints (NOT VALID, so existing rows are left alone and only
  new writes are checked) that bound text lengths, jsonb sizes and enum values.

## Security impact
- The browser can read and insert saved analyses, but every insert is size-
  and value-bounded. It can no longer modify or delete anything.
- The counter table and its RPC are reachable only by the service role used
  inside the Edge Functions.
*/

-- function_usage: RLS on, no policies, no privileges for browser roles
ALTER TABLE function_usage ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'function_usage'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.function_usage', pol.policyname);
  END LOOP;
END $$;

REVOKE ALL ON function_usage FROM PUBLIC, anon, authenticated;

-- upsert_function_usage: SECURITY DEFINER, fixed search_path, service_role only
ALTER FUNCTION upsert_function_usage(p_function_name text, p_usage_date date) SECURITY DEFINER;
ALTER FUNCTION upsert_function_usage(p_function_name text, p_usage_date date) SET search_path = public;
REVOKE EXECUTE ON FUNCTION upsert_function_usage(p_function_name text, p_usage_date date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION upsert_function_usage(p_function_name text, p_usage_date date) TO service_role;

-- App data tables: drop every UPDATE / DELETE / ALL policy
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('analyses', 'merchants', 'drafts')
      AND cmd IN ('UPDATE', 'DELETE', 'ALL')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;

-- Privileges: SELECT + INSERT only for browser roles
REVOKE ALL ON analyses, merchants, drafts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON analyses, merchants, drafts TO anon, authenticated;

-- Intentionally public single-tenant demo (no sign-in): read + opt-in save only
DROP POLICY IF EXISTS "Public read analyses" ON analyses;
CREATE POLICY "Public read analyses" ON analyses FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "Public insert analyses" ON analyses;
CREATE POLICY "Public insert analyses" ON analyses FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Public read merchants" ON merchants;
CREATE POLICY "Public read merchants" ON merchants FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "Public insert merchants" ON merchants;
CREATE POLICY "Public insert merchants" ON merchants FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Public read drafts" ON drafts;
CREATE POLICY "Public read drafts" ON drafts FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "Public insert drafts" ON drafts;
CREATE POLICY "Public insert drafts" ON drafts FOR INSERT TO anon, authenticated WITH CHECK (true);

-- Bounded INSERT payloads (NOT VALID: checks new rows only)
ALTER TABLE analyses DROP CONSTRAINT IF EXISTS analyses_bounded_payload;
ALTER TABLE analyses ADD CONSTRAINT analyses_bounded_payload CHECK (
  char_length(title) <= 300
  AND jev_mode IN ('live', 'replay', 'heuristic')
  AND llm_mode IN ('live', 'mock')
  AND (jev_requests IS NULL OR octet_length(jev_requests::text) <= 65536)
) NOT VALID;

ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_bounded_payload;
ALTER TABLE merchants ADD CONSTRAINT merchants_bounded_payload CHECK (
  (question_id IS NULL OR char_length(question_id) <= 16)
  AND char_length(display_name) <= 500
  AND status IN ('subscription', 'maybe', 'not_subscription')
  AND status_source IN ('jev', 'heuristic', 'user', 'replay')
  AND (charges IS NULL OR octet_length(charges::text) <= 262144)
  AND (cadence IS NULL OR octet_length(cadence::text) <= 4096)
  AND (price_hike IS NULL OR octet_length(price_hike::text) <= 4096)
  AND (trial IS NULL OR octet_length(trial::text) <= 4096)
) NOT VALID;

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_bounded_payload;
ALTER TABLE drafts ADD CONSTRAINT drafts_bounded_payload CHECK (
  tone IN ('polite', 'firm', 'refund')
  AND char_length(subject) <= 500
  AND char_length(body) <= 10000
) NOT VALID;
