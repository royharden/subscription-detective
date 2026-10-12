// save-analysis: the only write path for opt-in saved analyses. Browser roles have SELECT
// only; this function validates and whitelists every column, bounds every payload, and
// inserts with the service role. It makes no AI call, so it does not touch the AI functions'
// caps; it has its own per-function daily cap (DAILY_CALL_LIMIT, default 200) via function_usage.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const DAILY_LIMIT = parseDailyLimit(Deno.env.get("DAILY_CALL_LIMIT"));

// Input bounds (mirrored by CHECK constraints on the tables).
const MAX_BODY_BYTES = 512 * 1024;
const MAX_TITLE_CHARS = 200;
const MAX_FIELD_CHARS = 200;
const MAX_QUESTION_ID_CHARS = 16;
const MAX_MERCHANTS = 500;
const MAX_CHARGES_PER_MERCHANT = 500;
const MAX_REQUEST_LOGS = 100;
const MAX_DRAFTS = 100;
const MAX_SUBJECT_CHARS = 500;
const MAX_DRAFT_BODY_CHARS = 10000;
const MAX_ABS_CENTS = 2_000_000_000; // fits a Postgres integer
const MAX_COST_USD = 1_000_000;

const JEV_MODES = ["live", "replay", "heuristic"] as const;
const LLM_MODES = ["live", "mock"] as const;
const STATUSES = ["subscription", "maybe", "not_subscription"] as const;
const STATUS_SOURCES = ["jev", "heuristic", "user", "replay"] as const;
const CADENCES = ["weekly", "biweekly", "monthly", "quarterly", "annual", "irregular"] as const;
const TONES = ["polite", "firm", "refund"] as const;

type Failure = { ok: false; response: Response };

class ValidationError extends Error {}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

function parseDailyLimit(raw: string | undefined): number {
  const value = raw?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : 200;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Service-role client from env only. Returns null when either env var is missing so the
// caller can answer 503 instead of building a client from an empty string.
function getAdminClient(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Reads the body with a hard byte cap (Content-Length can be absent or wrong).
async function readJsonBody(req: Request): Promise<{ ok: true; value: unknown } | Failure> {
  const tooLarge: Failure = { ok: false, response: err("Request body too large (max 512 KB).", 413) };
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge;
  if (!req.body) return { ok: false, response: err("Request body must be valid JSON.", 400) };

  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return tooLarge;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, response: err("Request body must be valid JSON.", 400) };
  }
}

// ---- field validators (throw ValidationError -> 422) ----

// NUL and unpaired surrogates can't be stored by Postgres text/jsonb.
const UNPAIRED_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function text(v: unknown, field: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) throw new ValidationError(`${field} must be a non-empty string.`);
  if (v.length > max) throw new ValidationError(`${field} must be at most ${max} characters.`);
  if (v.includes("\u0000") || UNPAIRED_SURROGATE_RE.test(v)) throw new ValidationError(`${field} contains characters that can't be stored.`);
  return v;
}

function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(", ")}.`);
  }
  return v as T;
}

function num(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new ValidationError(`${field} must be a number between ${min} and ${max}.`);
  }
  return v;
}

// Integer cents; fractional medians (x.5) are rounded so they fit integer columns.
function cents(v: unknown, field: string): number {
  return Math.round(num(v, field, -MAX_ABS_CENTS, MAX_ABS_CENTS));
}

function isoDate(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ||
    new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw new ValidationError(`${field} must be a YYYY-MM-DD date.`);
  }
  return v;
}

function optionalDate(v: unknown, field: string): string | null {
  return v === null || v === undefined || v === "" ? null : isoDate(v, field);
}

function list(v: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(v)) throw new ValidationError(`${field} must be an array.`);
  if (v.length > max) throw new ValidationError(`${field} has more than ${max} items.`);
  return v;
}

function obj(v: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(v)) throw new ValidationError(`${field} must be an object.`);
  return v;
}

function requestLog(v: unknown, field: string) {
  const r = obj(v, field);
  const usage = obj(r.usage, `${field}.usage`);
  return {
    question_count: Math.round(num(r.question_count, `${field}.question_count`, 0, 100_000)),
    usage: {
      input_tokens: Math.round(num(usage.input_tokens, `${field}.usage.input_tokens`, 0, 1_000_000_000)),
      output_tokens: Math.round(num(usage.output_tokens, `${field}.usage.output_tokens`, 0, 1_000_000_000)),
    },
    latency_ms: Math.round(num(r.latency_ms, `${field}.latency_ms`, 0, 86_400_000)),
    cost_usd: num(r.cost_usd, `${field}.cost_usd`, 0, MAX_COST_USD),
  };
}

function merchantRow(v: unknown, i: number) {
  const f = `merchants[${i}]`;
  const m = obj(v, f);
  const questionId = m.question_id === null || m.question_id === undefined || m.question_id === ""
    ? null
    : text(m.question_id, `${f}.question_id`, MAX_QUESTION_ID_CHARS);
  const charges = list(m.charges, `${f}.charges`, MAX_CHARGES_PER_MERCHANT).map((c, k) => {
    const charge = obj(c, `${f}.charges[${k}]`);
    return {
      date: isoDate(charge.date, `${f}.charges[${k}].date`),
      amountCents: cents(charge.amountCents, `${f}.charges[${k}].amountCents`),
      descriptor: text(charge.descriptor, `${f}.charges[${k}].descriptor`, MAX_FIELD_CHARS),
    };
  });
  const cadence = obj(m.cadence, `${f}.cadence`);
  const medianInterval = cadence.median_interval_days;
  let priceHike = null;
  if (m.price_hike !== null && m.price_hike !== undefined) {
    const h = obj(m.price_hike, `${f}.price_hike`);
    priceHike = {
      oldCents: cents(h.oldCents, `${f}.price_hike.oldCents`),
      newCents: cents(h.newCents, `${f}.price_hike.newCents`),
      date: isoDate(h.date, `${f}.price_hike.date`),
      percentChange: num(h.percentChange, `${f}.price_hike.percentChange`, -1_000_000, 1_000_000),
      extraPerYearCents: cents(h.extraPerYearCents, `${f}.price_hike.extraPerYearCents`),
    };
  }
  let trial = null;
  if (m.trial !== null && m.trial !== undefined) {
    const t = obj(m.trial, `${f}.trial`);
    trial = {
      convertedOn: isoDate(t.convertedOn, `${f}.trial.convertedOn`),
      fullPriceCents: cents(t.fullPriceCents, `${f}.trial.fullPriceCents`),
    };
  }
  return {
    question_id: questionId,
    display_name: text(m.display_name, `${f}.display_name`, MAX_FIELD_CHARS),
    charges,
    cadence: {
      cadence: oneOf(cadence.cadence, `${f}.cadence.cadence`, CADENCES),
      median_interval_days: medianInterval === null || medianInterval === undefined
        ? null
        : num(medianInterval, `${f}.cadence.median_interval_days`, 0, 100_000),
    },
    noul: num(m.noul, `${f}.noul`, 0, 1),
    status: oneOf(m.status, `${f}.status`, STATUSES),
    status_source: oneOf(m.status_source, `${f}.status_source`, STATUS_SOURCES),
    price_hike: priceHike,
    trial,
    next_renewal: optionalDate(m.next_renewal, `${f}.next_renewal`),
    monthly_cents: m.monthly_cents === null || m.monthly_cents === undefined ? null : cents(m.monthly_cents, `${f}.monthly_cents`),
  };
}

function draftRow(v: unknown, i: number) {
  const f = `drafts[${i}]`;
  const d = obj(v, f);
  return {
    merchant_key: text(d.merchant_key, `${f}.merchant_key`, MAX_FIELD_CHARS),
    tone: oneOf(d.tone, `${f}.tone`, TONES),
    subject: text(d.subject, `${f}.subject`, MAX_SUBJECT_CHARS),
    body: text(d.body, `${f}.body`, MAX_DRAFT_BODY_CHARS),
  };
}

function validateSave(body: unknown) {
  const b = obj(body, "body");
  const analysis = {
    title: text(b.title, "title", MAX_TITLE_CHARS),
    jev_mode: oneOf(b.jev_mode, "jev_mode", JEV_MODES),
    llm_mode: oneOf(b.llm_mode, "llm_mode", LLM_MODES),
    date_from: optionalDate(b.date_from, "date_from"),
    date_to: optionalDate(b.date_to, "date_to"),
    monthly_total_cents: cents(b.monthly_total_cents, "monthly_total_cents"),
    annual_total_cents: cents(b.annual_total_cents, "annual_total_cents"),
    jev_requests: list(b.jev_requests, "jev_requests", MAX_REQUEST_LOGS).map((r, i) => requestLog(r, `jev_requests[${i}]`)),
    jev_cost_usd: num(b.jev_cost_usd, "jev_cost_usd", 0, MAX_COST_USD),
  };
  const merchants = list(b.merchants, "merchants", MAX_MERCHANTS).map(merchantRow);
  const drafts = b.drafts === undefined ? [] : list(b.drafts, "drafts", MAX_DRAFTS).map(draftRow);
  return { analysis, merchants, drafts };
}

// Atomic check-and-increment: increments the daily counter and returns the new count.
// Fail CLOSED: an RPC error or a null/non-integer result means no write (503).
async function checkAndIncrement(
  supabaseAdmin: SupabaseClient,
  functionName: string,
): Promise<{ ok: true; count: number } | Failure> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { data, error } = await supabaseAdmin.rpc("upsert_function_usage", {
      p_function_name: functionName,
      p_usage_date: today,
    });
    if (error || typeof data !== "number" || !Number.isInteger(data)) {
      console.error("upsert_function_usage failed:", error?.message ?? `unexpected result ${JSON.stringify(data)}`);
      return { ok: false, response: err("Usage counter unavailable. Please try again later.", 503) };
    }
    if (data > DAILY_LIMIT) {
      return { ok: false, response: err("daily_limit", 429) };
    }
    return { ok: true, count: data };
  } catch (e) {
    console.error("upsert_function_usage threw:", e instanceof Error ? e.message : e);
    return { ok: false, response: err("Usage counter unavailable. Please try again later.", 503) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    if (req.method !== "POST") return err("Method not allowed. POST a JSON body.", 405);

    const supabaseAdmin = getAdminClient();
    if (!supabaseAdmin) {
      console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
      return err("Saving is unavailable. Please try again later.", 503);
    }

    const read = await readJsonBody(req);
    if (!read.ok) return read.response;

    let input: ReturnType<typeof validateSave>;
    try {
      input = validateSave(read.value);
    } catch (e) {
      if (e instanceof ValidationError) return err(e.message, 422);
      throw e;
    }

    const cap = await checkAndIncrement(supabaseAdmin, "save-analysis");
    if (!cap.ok) return cap.response;

    const { data: analysis, error: aErr } = await supabaseAdmin
      .from("analyses")
      .insert(input.analysis)
      .select("id")
      .single();
    if (aErr || !analysis) {
      console.error("analyses insert failed:", aErr?.message);
      return err("Could not save the analysis.", 500);
    }
    const analysisId = analysis.id as string;

    // Any later failure removes the analysis (merchants and drafts cascade).
    const rollback = async (what: string, message: string | undefined) => {
      console.error(`${what} insert failed:`, message);
      const { error } = await supabaseAdmin.from("analyses").delete().eq("id", analysisId);
      if (error) console.error("rollback of analysis", analysisId, "failed:", error.message);
      return err("Could not save the analysis.", 500);
    };

    const keyToId = new Map<string, string>();
    if (input.merchants.length > 0) {
      const { data: inserted, error: mErr } = await supabaseAdmin
        .from("merchants")
        .insert(input.merchants.map((m) => ({ ...m, analysis_id: analysisId })))
        .select("id, display_name");
      if (mErr) return await rollback("merchants", mErr.message);
      for (const m of inserted ?? []) keyToId.set(m.display_name as string, m.id as string);
    }

    const draftRows = input.drafts
      .map((d) => {
        const merchantId = keyToId.get(d.merchant_key);
        return merchantId ? { merchant_id: merchantId, tone: d.tone, subject: d.subject, body: d.body } : null;
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);
    if (draftRows.length > 0) {
      const { error: dErr } = await supabaseAdmin.from("drafts").insert(draftRows);
      if (dErr) return await rollback("drafts", dErr.message);
    }

    return json({ id: analysisId, merchants: keyToId.size, drafts: draftRows.length });
  } catch (e) {
    console.error("save-analysis unexpected error:", e instanceof Error ? e.stack ?? e.message : e);
    return err("Unexpected server error", 500);
  }
});
