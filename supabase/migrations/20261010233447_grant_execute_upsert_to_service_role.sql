/*
# Grant EXECUTE on upsert_function_usage to service_role

The previous lockdown migration revoked EXECUTE from PUBLIC, anon, and
authenticated but did not explicitly grant it to service_role. The service
role bypasses RLS and typically has broad privileges, but EXECUTE on
functions must be granted explicitly. This migration adds that grant.

## Changes
- GRANT EXECUTE ON FUNCTION upsert_function_usage(text, date) TO service_role
- No other changes; SECURITY DEFINER and search_path = public are unchanged.
*/

GRANT EXECUTE ON FUNCTION upsert_function_usage(p_function_name text, p_usage_date date) TO service_role;
