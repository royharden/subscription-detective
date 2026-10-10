/*
# Increment function_usage counter atomically

Used by the jev-detect and draft-cancellation Edge Functions to enforce the
200-calls-per-function-per-day demo cap. SECURITY DEFINER so the service-role
call can upsert; callable via RPC.
*/
CREATE OR REPLACE FUNCTION upsert_function_usage(
  p_function_name text,
  p_usage_date date
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO function_usage (function_name, usage_date, count)
  VALUES (p_function_name, p_usage_date, 1)
  ON CONFLICT (function_name, usage_date)
  DO UPDATE SET count = function_usage.count + 1
  RETURNING count;
$$;
