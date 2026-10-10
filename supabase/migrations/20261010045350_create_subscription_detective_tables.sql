/*
# Create opt-in save tables + daily usage counter

1. Plain-English explanation
   Subscription Detective lets a user optionally save an analysis (never raw CSV
   rows - only merchant summaries and results). This migration creates three
   tables for that, plus a small counter table that the Edge Functions use to
   enforce a daily demo cap of 200 calls per function.

2. New Tables
   - `analyses`: one saved analysis run.
     - `id` (uuid, primary key)
     - `title` (text)
     - `jev_mode` (text: live | replay | heuristic)
     - `llm_mode` (text: live | mock)
     - `date_from`, `date_to` (date range of the imported statement)
     - `monthly_total_cents`, `annual_total_cents` (integer cents)
     - `jev_requests` (jsonb: request log with usage, latency, cost)
     - `jev_cost_usd` (numeric)
     - `created_at` (timestamptz)
   - `merchants`: per-merchant result belonging to an analysis (ON DELETE CASCADE).
     - `id` (uuid), `analysis_id` (fk), `question_id` (text, e.g. m01)
     - `display_name` (text), `charges` (jsonb), `cadence` (jsonb)
     - `noul` (numeric 0-1), `status` (text), `status_source` (text)
     - `price_hike` (jsonb nullable), `trial` (jsonb nullable)
     - `next_renewal` (date nullable), `monthly_cents` (int nullable)
   - `drafts`: saved cancellation email drafts, tied to a merchant (ON DELETE CASCADE).
     - `id` (uuid), `merchant_id` (fk), `tone` (text), `subject` (text), `body` (text), `created_at`
   - `function_usage`: daily per-function call counter for the demo cap.
     - `function_name` (text), `usage_date` (date, UTC), `count` (int, default 0)
     - primary key (function_name, usage_date)

3. Security
   - RLS is ENABLED on all four tables.
   - This demo has no sign-in, so all policies are permissive for both anon and
     authenticated roles (intentionally public demo data, documented here).
   - Four separate policies per table (select/insert/update/delete), no FOR ALL.
   - `function_usage` is only touched by Edge Functions via the service role
     (service role bypasses RLS), so it has minimal anon policies (select only).

4. Important notes
   - No user_id columns: the app is single-tenant with no auth by design.
   - No raw CSV rows are ever stored: merchants.charges holds only cleaned
     per-merchant summaries (date + amount + descriptor) that the user opted in to save.
*/

CREATE TABLE IF NOT EXISTS analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  jev_mode text NOT NULL,
  llm_mode text NOT NULL,
  date_from date,
  date_to date,
  monthly_total_cents integer NOT NULL DEFAULT 0,
  annual_total_cents integer NOT NULL DEFAULT 0,
  jev_requests jsonb,
  jev_cost_usd numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  question_id text,
  display_name text NOT NULL,
  charges jsonb,
  cadence jsonb,
  noul numeric,
  status text NOT NULL,
  status_source text NOT NULL,
  price_hike jsonb,
  trial jsonb,
  next_renewal date,
  monthly_cents integer
);

CREATE TABLE IF NOT EXISTS drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  tone text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS function_usage (
  function_name text NOT NULL,
  usage_date date NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (function_name, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_merchants_analysis ON merchants(analysis_id);
CREATE INDEX IF NOT EXISTS idx_drafts_merchant ON drafts(merchant_id);

ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE function_usage ENABLE ROW LEVEL SECURITY;

-- Permissive policies: intentionally public single-tenant demo (no auth),
-- documents why USING (true) is correct here.
DROP POLICY IF EXISTS "Public read analyses" ON analyses;
CREATE POLICY "Public read analyses" ON analyses FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "Public insert analyses" ON analyses;
CREATE POLICY "Public insert analyses" ON analyses FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "Public update analyses" ON analyses;
CREATE POLICY "Public update analyses" ON analyses FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Public delete analyses" ON analyses;
CREATE POLICY "Public delete analyses" ON analyses FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Public read merchants" ON merchants;
CREATE POLICY "Public read merchants" ON merchants FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "Public insert merchants" ON merchants;
CREATE POLICY "Public insert merchants" ON merchants FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "Public update merchants" ON merchants;
CREATE POLICY "Public update merchants" ON merchants FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Public delete merchants" ON merchants;
CREATE POLICY "Public delete merchants" ON merchants FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Public read drafts" ON drafts;
CREATE POLICY "Public read drafts" ON drafts FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "Public insert drafts" ON drafts;
CREATE POLICY "Public insert drafts" ON drafts FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "Public update drafts" ON drafts;
CREATE POLICY "Public update drafts" ON drafts FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Public delete drafts" ON drafts;
CREATE POLICY "Public delete drafts" ON drafts FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Public read function usage" ON function_usage;
CREATE POLICY "Public read function usage" ON function_usage FOR SELECT TO anon, authenticated USING (true);
