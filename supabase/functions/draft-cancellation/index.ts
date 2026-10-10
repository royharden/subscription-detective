// draft-cancellation: LLM writes a cancellation email draft (text only).
// No temperature. JSON output. Mock mode when OPENAI_API_KEY is missing.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const DAILY_LIMIT = Number(Deno.env.get("DAILY_CALL_LIMIT")) || 200;

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

function dollars(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

// Atomic check-and-increment: increments the daily counter and returns the new count.
// Fail CLOSED: if the RPC errors or returns a non-number, the caller must not proceed.
async function checkAndIncrement(
  supabaseAdmin: ReturnType<typeof createClient>,
  functionName: string,
): Promise<{ ok: true; count: number } | { ok: false; response: Response }> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabaseAdmin.rpc("upsert_function_usage", {
    p_function_name: functionName,
    p_usage_date: today,
  });
  if (error || typeof data !== "number") {
    return { ok: false, response: err("Usage counter unavailable. Please try again later.", 503) };
  }
  if (data > DAILY_LIMIT) {
    return { ok: false, response: err("daily_limit", 429) };
  }
  return { ok: true, count: data };
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

    let body: DraftRequest;
    try {
      body = await req.json();
    } catch {
      return err("Request body must be valid JSON.", 400);
    }

    const { merchant, priceCents, cadence, lastChargeDate, tone } = body ?? {};
    if (typeof merchant !== "string" || !merchant.trim()) return err("merchant is required.", 422);
    if (typeof priceCents !== "number" || !Number.isFinite(priceCents)) return err("priceCents must be a number (integer cents).", 422);
    if (!["polite", "firm", "refund"].includes(tone)) return err("tone must be polite, firm, or refund.", 422);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    // Atomic check-and-increment BEFORE any upstream call. Fail closed on error.
    const cap = await checkAndIncrement(supabaseAdmin, "draft-cancellation");
    if (!cap.ok) return cap.response;

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-6-luna";
    const baseUrl = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";

    if (!apiKey) {
      // Mock mode: templates
      return json({ ...mockDraft(body), mode: "mock" });
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

    let parsed: { subject: string; body: string } | null = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
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
        if (res.status === 401) return err("OpenAI rejected the API key (401). Check OPENAI_API_KEY.", 502);
        if (res.status === 429) return err("LLM rate limited. Try again shortly.", 429);
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return err(`LLM error (HTTP ${res.status}): ${text.slice(0, 300)}`, 502);
        }
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content === "string") {
          const candidate = JSON.parse(content);
          if (typeof candidate?.subject === "string" && typeof candidate?.body === "string") {
            parsed = { subject: candidate.subject, body: candidate.body };
          }
        }
      } catch {
        // retry once
      }
    }

    if (!parsed) return err("The LLM could not produce a valid draft. Try again.", 502);
    return json({ ...parsed, mode: "live" });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Unexpected server error", 500);
  }
});
