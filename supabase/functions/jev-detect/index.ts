// jev-detect: one batched TypeSafe Jev request for all candidate merchants.
// Secrets are server-side only. Daily cap: 200 calls/day via function_usage.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const DAILY_LIMIT = 200;
const JEV_MODEL = "jev-1.13.0";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_COST_PER_INPUT_TOKEN_USD = 0.042 / 1_000_000;

interface CandidateState {
  name: string;
  sample_descriptors?: string[];
  charges?: Array<{ date: string; amount: number }>;
  cadence?: string;
  median_interval_days?: number | null;
  amount_variation?: string;
}

interface QuestionSpec {
  type: string;
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
  answers: Record<string, { type?: string; noul?: number }>;
  usage?: { input_tokens?: number; output_tokens?: number };
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

async function checkDailyLimit(supabaseAdmin: ReturnType<typeof createClient>, functionName: string): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabaseAdmin
    .from("function_usage")
    .select("count")
    .eq("function_name", functionName)
    .eq("usage_date", today)
    .maybeSingle();
  if (error) return false; // if the counter is unavailable, allow the call
  return (data?.count ?? 0) < DAILY_LIMIT;
}

async function incrementUsage(supabaseAdmin: ReturnType<typeof createClient>, functionName: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await supabaseAdmin.rpc("upsert_function_usage", {
    p_function_name: functionName,
    p_usage_date: today,
  });
  if (error) {
    // fallback: best-effort direct upsert
    await supabaseAdmin
      .from("function_usage")
      .upsert({ function_name: functionName, usage_date: today, count: 1 }, { onConflict: "function_name,usage_date", ignoreDuplicates: false });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    if (req.method !== "POST") return err("Method not allowed. POST a JSON body with state and questions.", 405);

    const apiKey = Deno.env.get("TYPESAFE_API_KEY");
    if (!apiKey) return err("TYPESAFE_API_KEY is not configured on the server. Replay mode will be used instead.", 503);

    let body: JevRequestBody;
    try {
      body = await req.json();
    } catch {
      return err("Request body must be valid JSON.", 400);
    }

    if (!body?.state?.merchants || !body?.questions) {
      return err("Body must include state.merchants and questions.", 422);
    }
    const questionIds = Object.keys(body.questions);
    if (questionIds.length === 0) return err("No questions provided.", 422);
    if (questionIds.length > 200) return err("Too many questions in one request.", 413);

    // State size guard: 32k tokens for state plus the longest question
    const stateTokens = JSON.stringify(body.state).length / 4;
    const longestQuestionTokens = Math.max(
      ...questionIds.map((id) => JSON.stringify(body.questions[id]).length / 4),
    );
    if (stateTokens + longestQuestionTokens > 32000) {
      return err("Request state too large. Split into smaller chunks client-side.", 413);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    if (!(await checkDailyLimit(supabaseAdmin, "jev-detect"))) {
      return err("daily_limit", 429);
    }

    const payload: JevRequestBody = {
      model: JEV_MODEL,
      state: body.state,
      questions: body.questions,
    };

    let lastError: string | null = null;
    let response: JevResponse | null = null;
    const started = Date.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(JEV_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        if (res.status === 429 || res.status === 529) {
          lastError = `TypeSafe rate limited (HTTP ${res.status})`;
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
        if (res.status === 401) return err("TypeSafe rejected the API key (401). Check TYPESAFE_API_KEY.", 502);
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return err(`TypeSafe error (HTTP ${res.status}): ${text.slice(0, 300)}`, 502);
        }
        response = await res.json();
        lastError = null;
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    const latency_ms = Date.now() - started;
    if (!response) return err(`TypeSafe request failed after retries: ${lastError}`, 502);

    console.log("jev-detect response.model:", response.model ?? "unknown");

    const answersRaw = response.answers ?? {};
    const missing = questionIds.filter((id) => !(id in answersRaw));
    if (missing.length > 0) {
      // one small follow-up request for missing IDs
      const retryPayload: JevRequestBody = {
        model: JEV_MODEL,
        state: { merchants: Object.fromEntries(missing.map((id) => [id, body.state.merchants[id]].filter(Boolean))) },
        questions: Object.fromEntries(missing.map((id) => [id, body.questions[id]])),
      };
      try {
        const retryRes = await fetch(JEV_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(retryPayload),
        });
        if (retryRes.ok) {
          const retryJson = (await retryRes.json()) as JevResponse;
          Object.assign(answersRaw, retryJson.answers ?? {});
        }
      } catch {
        // keep whatever answers we have
      }
    }

    await incrementUsage(supabaseAdmin, "jev-detect");

    const input_tokens = response.usage?.input_tokens ?? 0;
    const output_tokens = response.usage?.output_tokens ?? 0;
    const cost_usd = input_tokens * JEV_COST_PER_INPUT_TOKEN_USD;

    return json({
      model: response.model ?? JEV_MODEL,
      answers: answersRaw,
      usage: { input_tokens, output_tokens },
      latency_ms,
      cost_usd,
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Unexpected server error", 500);
  }
});
