// jev-detect: one batched TypeSafe Jev request for all candidate merchants.
// Secrets are server-side only. Daily cap: 200 upstream calls/day via function_usage,
// counted right before every TypeSafe fetch (each retry and the missing-ID follow-up too).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const DAILY_LIMIT = parseDailyLimit(Deno.env.get("DAILY_CALL_LIMIT"));
const JEV_MODEL = "jev-1.13.0";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_COST_PER_INPUT_TOKEN_USD = 0.042 / 1_000_000;

// Input bounds, enforced before any paid call.
const MAX_BODY_BYTES = 32 * 1024;
const MAX_QUESTIONS = 200;
const MAX_FIELD_CHARS = 200;
const MAX_QUESTION_TEXT_CHARS = 500;
const MAX_DESCRIPTORS = 5;
const MAX_CHARGES = 24;
const MAX_DATE_CHARS = 32;
const MAX_CRITERIA = 4;
const QUESTION_ID_RE = /^m\d{2,6}$/;

// Upstream retries: only on 429, 529 or network errors, max 2 attempts in total.
const MAX_ATTEMPTS = 2;

interface CandidateState {
  name: string;
  sample_descriptors?: string[];
  charges?: Array<{ date: string; amount: number }>;
  cadence?: string;
  median_interval_days?: number | null;
  amount_variation?: string;
}

interface QuestionSpec {
  type: "noul";
  instructions: string;
  criteria: Record<string, string>;
}

interface JevRequestBody {
  model: string;
  state: { merchants: Record<string, CandidateState> };
  questions: Record<string, QuestionSpec>;
}

interface JevResponse {
  model?: string;
  answers?: Record<string, { type?: string; noul?: number }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

type Failure = { ok: false; response: Response };

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

function isBoundedString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length <= max;
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
  const tooLarge: Failure = { ok: false, response: err("Request body too large (max 32 KB).", 413) };
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

// Whitelists and bounds one merchant summary. Returns null when anything is out of bounds.
function sanitizeMerchant(v: unknown): CandidateState | null {
  if (!isPlainObject(v)) return null;
  const { name, sample_descriptors, charges, cadence, median_interval_days, amount_variation } = v;
  if (!isBoundedString(name, MAX_FIELD_CHARS) || !name.trim()) return null;
  const out: CandidateState = { name };

  if (sample_descriptors !== undefined) {
    if (
      !Array.isArray(sample_descriptors) ||
      sample_descriptors.length > MAX_DESCRIPTORS ||
      !sample_descriptors.every((d) => isBoundedString(d, MAX_FIELD_CHARS))
    ) {
      return null;
    }
    out.sample_descriptors = sample_descriptors as string[];
  }
  if (charges !== undefined) {
    if (!Array.isArray(charges) || charges.length > MAX_CHARGES) return null;
    const cleaned: Array<{ date: string; amount: number }> = [];
    for (const c of charges) {
      if (!isPlainObject(c)) return null;
      const { date, amount } = c;
      if (!isBoundedString(date, MAX_DATE_CHARS) || typeof amount !== "number" || !Number.isFinite(amount)) return null;
      cleaned.push({ date, amount });
    }
    out.charges = cleaned;
  }
  if (cadence !== undefined) {
    if (!isBoundedString(cadence, MAX_FIELD_CHARS)) return null;
    out.cadence = cadence;
  }
  if (median_interval_days !== undefined) {
    if (median_interval_days !== null && (typeof median_interval_days !== "number" || !Number.isFinite(median_interval_days))) {
      return null;
    }
    out.median_interval_days = median_interval_days;
  }
  if (amount_variation !== undefined) {
    if (!isBoundedString(amount_variation, MAX_FIELD_CHARS)) return null;
    out.amount_variation = amount_variation;
  }
  return out;
}

// Only yes/no ("noul") questions with bounded text are forwarded.
function sanitizeQuestion(v: unknown): QuestionSpec | null {
  if (!isPlainObject(v)) return null;
  const { type, instructions, criteria } = v;
  if (type !== "noul" || !isBoundedString(instructions, MAX_QUESTION_TEXT_CHARS) || !isPlainObject(criteria)) return null;
  const entries = Object.entries(criteria);
  if (
    entries.length === 0 ||
    entries.length > MAX_CRITERIA ||
    !entries.every(([k, text]) => k.length <= 32 && isBoundedString(text, MAX_QUESTION_TEXT_CHARS))
  ) {
    return null;
  }
  return { type: "noul", instructions, criteria: Object.fromEntries(entries) as Record<string, string> };
}

// Atomic check-and-increment: increments the daily counter and returns the new count.
// Fail CLOSED: an RPC error or a null/non-integer result means no upstream call (503).
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

// One logical Jev request. Every fetch (first try and retry) is counted right before it is
// sent; a daily_limit or counter failure stops immediately with no further upstream call.
async function callJev(
  supabaseAdmin: SupabaseClient,
  apiKey: string,
  payload: JevRequestBody,
  maxAttempts: number,
): Promise<{ ok: true; data: JevResponse } | Failure> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));

    const cap = await checkAndIncrement(supabaseAdmin, "jev-detect");
    if (!cap.ok) return cap;

    let res: Response;
    try {
      res = await fetch(JEV_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.error(`TypeSafe network error (attempt ${attempt + 1}):`, e instanceof Error ? e.message : e);
      continue;
    }

    if (res.status === 429 || res.status === 529) {
      console.warn(`TypeSafe rate limited (HTTP ${res.status}, attempt ${attempt + 1})`);
      await res.body?.cancel().catch(() => {});
      continue;
    }
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      console.error("TypeSafe rejected the API key (401)");
      return { ok: false, response: err("TypeSafe rejected the API key (401). Check TYPESAFE_API_KEY.", 502) };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`TypeSafe error (HTTP ${res.status}):`, text.slice(0, 1000));
      return { ok: false, response: err(`Jev request failed (upstream HTTP ${res.status}).`, 502) };
    }
    try {
      return { ok: true, data: (await res.json()) as JevResponse };
    } catch (e) {
      console.error("TypeSafe returned invalid JSON:", e instanceof Error ? e.message : e);
      return { ok: false, response: err("Jev returned an unexpected response.", 502) };
    }
  }
  return { ok: false, response: err("Jev is busy or unreachable. Please try again later.", 502) };
}

// Keeps only answers to the questions we asked, with a probability in [0, 1].
function pickAnswers(raw: unknown, ids: string[]): Record<string, { type: "noul"; noul: number }> {
  const out: Record<string, { type: "noul"; noul: number }> = {};
  if (!isPlainObject(raw)) return out;
  for (const id of ids) {
    const answer = raw[id];
    const noul = isPlainObject(answer) ? answer.noul : undefined;
    if (typeof noul === "number" && Number.isFinite(noul) && noul >= 0 && noul <= 1) {
      out[id] = { type: "noul", noul };
    }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    if (req.method !== "POST") return err("Method not allowed. POST a JSON body with state and questions.", 405);

    const apiKey = Deno.env.get("TYPESAFE_API_KEY");
    if (!apiKey) return err("TYPESAFE_API_KEY is not configured on the server. Replay mode will be used instead.", 503);

    const supabaseAdmin = getAdminClient();
    if (!supabaseAdmin) {
      console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
      return err("Usage counter unavailable. Please try again later.", 503);
    }

    const read = await readJsonBody(req);
    if (!read.ok) return read.response;
    const body = read.value;

    if (!isPlainObject(body) || !isPlainObject(body.state) || !isPlainObject(body.state.merchants) || !isPlainObject(body.questions)) {
      return err("Body must include state.merchants and questions.", 422);
    }
    const rawMerchants = body.state.merchants;
    const rawQuestions = body.questions;

    const questionIds = Object.keys(rawQuestions);
    if (questionIds.length === 0) return err("No questions provided.", 422);
    if (questionIds.length > MAX_QUESTIONS || Object.keys(rawMerchants).length > MAX_QUESTIONS) {
      return err("Too many questions in one request.", 422);
    }

    const merchants: Record<string, CandidateState> = {};
    for (const [id, value] of Object.entries(rawMerchants)) {
      if (!QUESTION_ID_RE.test(id)) return err("state.merchants keys must be question IDs like m01.", 422);
      const merchant = sanitizeMerchant(value);
      if (!merchant) return err(`state.merchants.${id} is invalid or exceeds field limits (${MAX_FIELD_CHARS} chars).`, 422);
      merchants[id] = merchant;
    }
    const questions: Record<string, QuestionSpec> = {};
    for (const id of questionIds) {
      if (!QUESTION_ID_RE.test(id)) return err("Question IDs must look like m01.", 422);
      const question = sanitizeQuestion(rawQuestions[id]);
      if (!question) return err(`questions.${id} is invalid or exceeds field limits.`, 422);
      if (!merchants[id]) return err(`questions.${id} has no matching state.merchants entry.`, 422);
      questions[id] = question;
    }

    // State size guard: 32k tokens for state plus the longest question
    const state = { merchants };
    const stateTokens = JSON.stringify(state).length / 4;
    const longestQuestionTokens = Math.max(...questionIds.map((id) => JSON.stringify(questions[id]).length / 4));
    if (stateTokens + longestQuestionTokens > 32000) {
      return err("Request state too large. Split into smaller chunks client-side.", 413);
    }

    const started = Date.now();
    const main = await callJev(supabaseAdmin, apiKey, { model: JEV_MODEL, state, questions }, MAX_ATTEMPTS);
    if (!main.ok) return main.response;
    const response = main.data;

    console.log("jev-detect response.model:", response.model ?? "unknown");

    const answers = pickAnswers(response.answers, questionIds);
    let input_tokens = response.usage?.input_tokens ?? 0;
    let output_tokens = response.usage?.output_tokens ?? 0;

    const missing = questionIds.filter((id) => !(id in answers));
    if (missing.length > 0) {
      // one small follow-up request for missing IDs (counted like any other upstream call)
      const followUp = await callJev(
        supabaseAdmin,
        apiKey,
        {
          model: JEV_MODEL,
          state: { merchants: Object.fromEntries(missing.map((id) => [id, merchants[id]])) },
          questions: Object.fromEntries(missing.map((id) => [id, questions[id]])),
        },
        1,
      );
      if (followUp.ok) {
        Object.assign(answers, pickAnswers(followUp.data.answers, missing));
        input_tokens += followUp.data.usage?.input_tokens ?? 0;
        output_tokens += followUp.data.usage?.output_tokens ?? 0;
      } else if (followUp.response.status === 429 || followUp.response.status === 503) {
        // daily_limit or counter unavailable: stop immediately
        return followUp.response;
      }
      // any other follow-up failure: keep whatever answers we have
    }
    const latency_ms = Date.now() - started;
    const cost_usd = input_tokens * JEV_COST_PER_INPUT_TOKEN_USD;

    return json({
      model: response.model ?? JEV_MODEL,
      answers,
      usage: { input_tokens, output_tokens },
      latency_ms,
      cost_usd,
    });
  } catch (e) {
    console.error("jev-detect unexpected error:", e instanceof Error ? e.stack ?? e.message : e);
    return err("Unexpected server error", 500);
  }
});
