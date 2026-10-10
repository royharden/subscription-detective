/*
# Lock down function_usage and remove unnecessary UPDATE/DELETE policies

## Plain-English explanation
The demo's daily-call-cap counter (function_usage) should only be touched by
the Edge Functions via the service role, never by anon or authenticated clients.
The app data tables (analyses, merchants, drafts) only need SELECT and INSERT
from the anon-key frontend - UPDATE and DELETE were overly permissive. "Clear
all data" still works because the service role bypasses RLS.

## Changes

### function_usage table
- Drops the single "Public read function usage" SELECT policy so no anon or
  authenticated policy remains. RLS stays enabled, which means the table is
  now locked to all roles except service_role (which bypasses RLS).
- REVOKE ALL privileges on function_usage FROM anon and authenticated.

### upsert_function_usage function
- REVOKE EXECUTE FROM PUBLIC, anon, and authenticated so only service_role
  (and superuser) can call it.
- The function keeps SECURITY DEFINER and the fixed search_path = public.

### analyses table
- Drops the "Public update analyses" and "Public delete analyses" policies.
- anon/authenticated keep SELECT and INSERT only.

### merchants table
- Drops the "Public update merchants" and "Public delete merchants" policies.
- anon/authenticated keep SELECT and INSERT only.

### drafts table
- Drops the "Public update drafts" and "Public delete drafts" policies.
- anon/authenticated keep SELECT and INSERT only.

### Grant cleanup
- REVOKE UPDATE, DELETE ON analyses, merchants, drafts FROM anon, authenticated
  so even if a policy is accidentally re-added, the privilege does not exist.

## Security impact
- function_usage is now invisible and unmodifiable by the browser client.
- The upsert_function_usage RPC is callable only by the service role.
- The frontend can read and insert saved analyses/merchants/drafts but can no
  longer UPDATE or DELETE them through the anon key. "Clear all data" uses the
  service-role client in the edge function, which bypasses RLS.
*/

-- function_usage: remove the only anon/authenticated policy and all privileges
DROP POLICY IF EXISTS "Public read function usage" ON function_usage;
REVOKE ALL ON function_usage FROM anon, authenticated;

-- upsert_function_usage: restrict EXECUTE to service_role only
REVOKE EXECUTE ON FUNCTION upsert_function_usage(p_function_name text, p_usage_date date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION upsert_function_usage(p_function_name text, p_usage_date date) FROM anon, authenticated;

-- analyses: drop UPDATE and DELETE policies
DROP POLICY IF EXISTS "Public update analyses" ON analyses;
DROP POLICY IF EXISTS "Public delete analyses" ON analyses;
REVOKE UPDATE, DELETE ON analyses FROM anon, authenticated;

-- merchants: drop UPDATE and DELETE policies
DROP POLICY IF EXISTS "Public update merchants" ON merchants;
DROP POLICY IF EXISTS "Public delete merchants" ON merchants;
REVOKE UPDATE, DELETE ON merchants FROM anon, authenticated;

-- drafts: drop UPDATE and DELETE policies
DROP POLICY IF EXISTS "Public update drafts" ON drafts;
DROP POLICY IF EXISTS "Public delete drafts" ON drafts;
REVOKE UPDATE, DELETE ON drafts FROM anon, authenticated;
