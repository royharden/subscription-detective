// draft-cancellation: LLM writes a cancellation email draft (text only).
// No temperature. JSON output. Mock mode when OPENAI_API_KEY is missing.
// Daily cap: 200 upstream calls/day via function_usage, counted right before every
// OpenAI fetch (each retry too). Mock mode makes no upstream call and is not counted.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const DAILY_LIMIT = parseDailyLimit(Deno.env.get("DAILY_CALL_LIMIT"));

// Input bounds, enforced before any paid call or prompt building.
const MAX_BODY_BYTES = 32 * 1024;
const MAX_FIELD_CHARS = 200;
const TONES = ["polite", "firm", "refund"] as const;

// Upstream retries: only on 429, 529 or network errors, max 2 attempts in total.
const MAX_ATTEMPTS = 2;

type Tone = "polite" | "firm" | "refund";

interface DraftRequest {
  merchant: string;
  priceCents: number;
  cadence: string;
  lastChargeDate: string;
  tone: Tone;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

type Failure = { ok: false; response: Response };

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

// Whitelists the draft fields and bounds every string field.
function validateDraftRequest(body: unknown): { ok: true; value: DraftRequest } | Failure {
  if (!isPlainObject(body)) return { ok: false, response: err("Request body must be a JSON object.", 422) };
  const { merchant, priceCents, cadence, lastChargeDate, tone } = body;
  if (typeof merchant !== "string" || !merchant.trim()) return { ok: false, response: err("merchant is required.", 422) };
  if (merchant.length > MAX_FIELD_CHARS) {
    return { ok: false, response: err(`merchant must be at most ${MAX_FIELD_CHARS} characters.`, 422) };
  }
  if (typeof priceCents !== "number" || !Number.isFinite(priceCents)) {
    return { ok: false, response: err("priceCents must be a number (integer cents).", 422) };
  }
  if (!isBoundedString(cadence, MAX_FIELD_CHARS)) {
    return { ok: false, response: err(`cadence must be a string of at most ${MAX_FIELD_CHARS} characters.`, 422) };
  }
  if (!isBoundedString(lastChargeDate, MAX_FIELD_CHARS)) {
    return { ok: false, response: err(`lastChargeDate must be a string of at most ${MAX_FIELD_CHARS} characters.`, 422) };
  }
  if (typeof tone !== "string" || !(TONES as readonly string[]).includes(tone)) {
    return { ok: false, response: err("tone must be polite, firm, or refund.", 422) };
  }
  return { ok: true, value: { merchant, priceCents, cadence, lastChargeDate, tone: tone as Tone } };
}

function dollars(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
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

function mockDraft(input: DraftRequest): { subject: string; body: string } {
  const price = dollars(input.priceCents);
  const merchant = input.merchant;
  if (input.tone === "firm") {
    return {
      subject: `Cancel my ${merchant} subscription immediately - account [Account or order ID]`,
      body: `Hello ${merchant} team,

I am canceling my ${input.cadence} subscription (account [Account or order ID]) effective immediately. Do not renew it.

The most recent charge was ${price} on ${input.lastChargeDate}. I want confirmation in writing that:
1. The subscription is canceled and will not renew.
2. No further charges will be made to my payment method.

If any charge occurs after this date, I will dispute it.

[Your name]
[Account email]`,
    };
  }
  if (input.tone === "refund") {
    return {
      subject: `Cancellation and refund request for ${merchant} - [Account or order ID]`,
      body: `Hello ${merchant} support,

I would like to cancel my ${merchant} ${input.cadence} subscription (account [Account or order ID]) and request a refund for the latest charge of ${price} on ${input.lastChargeDate}. I do not intend to use the service going forward.

Please confirm the cancellation and the refund to [Account email].

Thank you,
[Your name]`,
    };
  }
  return {
    subject: `Request to cancel my ${merchant} subscription`,
    body: `Hello ${merchant} team,

I would like to cancel my ${input.cadence} subscription (account [Account or order ID]). The most recent charge was ${price} on ${input.lastChargeDate}.

Could you please confirm the cancellation and that no further charges will be made? You can reach me at [Account email].

Thank you for your help,
[Your name]`,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    if (req.method !== "POST") return err("Method not allowed. POST a JSON body.", 405);

    const read = await readJsonBody(req);
    if (!read.ok) return read.response;
    const validated = validateDraftRequest(read.value);
    if (!validated.ok) return validated.response;
    const input = validated.value;
    const { merchant, priceCents, cadence, lastChargeDate, tone } = input;

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-6-luna";
    const baseUrl = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";

    if (!apiKey) {
      // Mock mode: templates (no upstream call, so nothing to count)
      return json({ ...mockDraft(input), mode: "mock" });
    }

    const supabaseAdmin = getAdminClient();
    if (!supabaseAdmin) {
      console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
      return err("Usage counter unavailable. Please try again later.", 503);
    }

    const price = dollars(priceCents);
    const toneText =
      tone === "firm"
        ? "Write firmly and unambiguously demand cancellation and written confirmation that no further charges will occur."
        : tone === "refund"
          ? "Politely request cancellation AND a refund of the latest charge."
          : "Write politely and professionally.";

    const systemPrompt = `You write short cancellation emails for subscriptions. ${toneText}
Rules:
- Output JSON only: {"subject": string, "body": string}.
- Use the placeholders [Your name], [Account email], and [Account or order ID] where personal details would go.
- Never include card numbers, full names, or invented company policies, phone numbers, or addresses.
- Keep the body under 180 words.`;

    const userPrompt = `Merchant: ${merchant}
Price: ${price} per ${cadence} billing cycle
Last charge date: ${lastChargeDate}
Tone: ${tone}`;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));

      // Atomic check-and-increment right before EVERY upstream fetch. Fail closed.
      const cap = await checkAndIncrement(supabaseAdmin, "draft-cancellation");
      if (!cap.ok) return cap.response;

      let res: Response;
      try {
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            response_format: { type: "json_object" },
          }),
        });
      } catch (e) {
        console.error(`LLM network error (attempt ${attempt + 1}):`, e instanceof Error ? e.message : e);
        continue;
      }

      if (res.status === 429 || res.status === 529) {
        console.warn(`LLM rate limited (HTTP ${res.status}, attempt ${attempt + 1})`);
        await res.body?.cancel().catch(() => {});
        continue;
      }
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        console.error("OpenAI rejected the API key (401)");
        return err("OpenAI rejected the API key (401). Check OPENAI_API_KEY.", 502);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`LLM error (HTTP ${res.status}):`, text.slice(0, 1000));
        return err(`The LLM request failed (upstream HTTP ${res.status}). Try again.`, 502);
      }

      try {
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        const candidate = typeof content === "string" ? JSON.parse(content) : null;
        if (typeof candidate?.subject === "string" && typeof candidate?.body === "string") {
          return json({ subject: candidate.subject, body: candidate.body, mode: "live" });
        }
        console.error("LLM returned JSON without subject/body");
      } catch (e) {
        console.error("LLM returned an unparseable response:", e instanceof Error ? e.message : e);
      }
      return err("The LLM could not produce a valid draft. Try again.", 502);
    }

    // Upstream still rate limited or unreachable after the allowed retries.
    return err("The LLM is busy or unreachable. Try again shortly.", 503);
  } catch (e) {
    console.error("draft-cancellation unexpected error:", e instanceof Error ? e.stack ?? e.message : e);
    return err("Unexpected server error", 500);
  }
});
