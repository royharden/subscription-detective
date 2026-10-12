import { createClient, FunctionsHttpError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { JevDetectResult, draftResultSchema, planChunks, buildQuestions, buildState, QuestionEntry } from './analysis';
import { CandidateSummary } from './csv';
import { RecordedJevFixture } from './recordedJev';
import { templateDraft } from './draftTemplates';
import { detectPriceHikes, detectTrialConversion, cadenceStats, monthlyEquivalentCents } from './detection';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Only create the client when both VITE_ vars are present (and accepted by createClient).
// Otherwise the app still renders with a setup message, and the sample CSV + Replay keep working.
function createSupabaseClient(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseAnonKey) return null;
  try {
    return createClient(supabaseUrl, supabaseAnonKey);
  } catch (e) {
    console.error('Supabase client could not be created. Check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.', e);
    return null;
  }
}

export const supabase: SupabaseClient | null = createSupabaseClient();

export const supabaseReady = supabase !== null;

interface InvokeResult {
  ok: boolean;
  status: number;
  json: unknown;
}

// supabase.functions.invoke sends the anon key as Authorization: Bearer + apikey, which the
// functions require (verify_jwt = true). On a non-2xx reply the status and JSON body are
// read from error.context (the raw Response).
async function invokeFunction(name: string, body: Record<string, unknown>): Promise<InvokeResult> {
  if (!supabase) {
    return { ok: false, status: 503, json: { error: 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.' } };
  }
  try {
    const { data, error } = await supabase.functions.invoke(name, { body });
    if (!error) return { ok: true, status: 200, json: data };
    if (error instanceof FunctionsHttpError) {
      const res = error.context as Response;
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { ok: false, status: res.status, json };
    }
    return { ok: false, status: 0, json: { error: error instanceof Error ? error.message : String(error) } };
  } catch (e) {
    return { ok: false, status: 0, json: { error: e instanceof Error ? e.message : String(e) } };
  }
}

function errorField(json: unknown): string | undefined {
  const value = (json as { error?: unknown } | null)?.error;
  return typeof value === 'string' ? value : undefined;
}

// Only our own 429 { error: "daily_limit" } is the daily demo limit. Any other 429 (for
// example a platform rate limit) is reported as a normal error, not as the demo limit.
function isDailyLimit(result: InvokeResult): boolean {
  return result.status === 429 && errorField(result.json) === 'daily_limit';
}

export interface DetectOutcome {
  result: JevDetectResult | null;
  error?: string;
}

const jevChunkResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.object({ noul: z.number() }).passthrough()),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

async function invokeJevDetect(entries: QuestionEntry[]): Promise<z.infer<typeof jevChunkResponseSchema>> {
  const result = await invokeFunction('jev-detect', { state: buildState(entries), questions: buildQuestions(entries) });
  if (!result.ok) {
    if (isDailyLimit(result)) throw new Error('daily_limit');
    throw new Error(errorField(result.json) ?? `jev-detect failed (${result.status})`);
  }
  const parsed = jevChunkResponseSchema.safeParse(result.json);
  if (!parsed.success) throw new Error('Unexpected response from jev-detect');
  return parsed.data;
}

async function callJevLive(candidates: CandidateSummary[]): Promise<JevDetectResult> {
  const { chunks } = planChunks(candidates);
  const answers: Record<string, { noul: number; confidence: number }> = {};
  const requests: JevDetectResult['requests'] = [];
  let model = 'jev-1.13.0';

  for (const chunk of chunks) {
    const started = performance.now();
    const first = await invokeJevDetect(chunk);
    if (first.model) model = first.model;
    const chunkAnswers: Record<string, { noul: number }> = {};
    for (const entry of chunk) {
      const a = first.answers[entry.id];
      if (a) chunkAnswers[entry.id] = a;
    }
    const usage = { ...(first.usage ?? { input_tokens: 0, output_tokens: 0 }) };

    // retry once for missing IDs, keeping each merchant's original question ID
    const missing = chunk.filter((entry) => !(entry.id in chunkAnswers));
    if (missing.length > 0) {
      try {
        const retry = await invokeJevDetect(missing);
        for (const entry of missing) {
          const a = retry.answers[entry.id];
          if (a) chunkAnswers[entry.id] = a;
        }
        usage.input_tokens += retry.usage?.input_tokens ?? 0;
        usage.output_tokens += retry.usage?.output_tokens ?? 0;
      } catch (e) {
        // never call again after the daily limit; any other retry failure keeps what we have
        if (e instanceof Error && e.message === 'daily_limit') throw e;
      }
    }
    const latency_ms = Math.round(performance.now() - started);

    for (const [id, a] of Object.entries(chunkAnswers)) {
      // Store keyed by question ID (m01, m02, ...) so analyzeMerchants can look them up
      answers[id] = { noul: a.noul, confidence: Math.abs(2 * a.noul - 1) };
    }
    requests.push({
      question_count: Object.keys(chunkAnswers).length,
      usage,
      latency_ms,
      cost_usd: (usage.input_tokens * 0.042) / 1_000_000,
    });
  }

  return { answers_by_merchant: answers, model, requests, mode: 'live' };
}

function heuristicResult(): JevDetectResult {
  return { answers_by_merchant: {}, model: 'heuristic', requests: [], mode: 'heuristic' };
}

export async function runDetection(
  candidates: CandidateSummary[],
  fixture: RecordedJevFixture | null,
  summariesHash: string | null,
  isSample: boolean,
): Promise<DetectOutcome> {
  // Replay only applies when the input matches the recorded summaries hash
  if (fixture && isSample && summariesHash === fixture.summaries_hash) {
    const answers: Record<string, { noul: number; confidence: number }> = {};
    for (const [id, a] of Object.entries(fixture.recorded_response.answers)) {
      answers[id] = { noul: a.noul, confidence: Math.abs(2 * a.noul - 1) };
    }
    return {
      result: {
        answers_by_merchant: answers,
        model: fixture.recorded_response.model,
        requests: [
          {
            question_count: fixture.request_log.question_count,
            usage: fixture.recorded_response.usage,
            latency_ms: fixture.request_log.latency_ms,
            cost_usd: (fixture.recorded_response.usage.input_tokens * 0.042) / 1_000_000,
          },
        ],
        mode: 'replay',
      },
    };
  }
  if (!supabaseReady) {
    // No Supabase configured: use heuristic so the sample CSV still works
    return { result: heuristicResult(), error: 'Supabase not configured' };
  }
  try {
    const result = await callJevLive(candidates);
    return { result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'daily_limit') return { result: heuristicResult(), error: 'daily_limit' };
    // network or API error: fall back to labeled heuristic
    return { result: heuristicResult(), error: msg };
  }
}

export interface DraftInput {
  merchant: string;
  priceCents: number;
  cadence: string;
  lastChargeDate: string;
  tone: 'polite' | 'firm' | 'refund';
}

export async function draftCancellation(input: DraftInput): Promise<{ subject: string; body: string; mode: 'live' | 'mock' }> {
  if (!supabase) {
    // No Supabase configured: build the draft from templates so the demo keeps working
    return { ...templateDraft(input), mode: 'mock' };
  }
  // draft-cancellation rejects string fields over 200 characters
  const clip = (s: string) => s.slice(0, 200);
  const result = await invokeFunction('draft-cancellation', {
    merchant: clip(input.merchant),
    priceCents: input.priceCents,
    cadence: clip(input.cadence),
    lastChargeDate: clip(input.lastChargeDate),
    tone: input.tone,
  });
  if (!result.ok) {
    if (isDailyLimit(result)) throw new Error('daily_limit');
    throw new Error(errorField(result.json) ?? `draft-cancellation failed (${result.status})`);
  }
  const parsed = draftResultSchema.safeParse(result.json);
  if (!parsed.success) throw new Error('Unexpected response from draft-cancellation');
  return { subject: parsed.data.subject, body: parsed.data.body, mode: parsed.data.mode };
}

export interface SavedAnalysis {
  id: string;
  title: string;
  created_at: string;
  monthly_total_cents: number;
  annual_total_cents: number;
}

export async function saveAnalysis(payload: {
  title: string;
  jev_mode: string;
  llm_mode: string;
  date_from: string;
  date_to: string;
  monthly_total_cents: number;
  annual_total_cents: number;
  jev_requests: unknown;
  jev_cost_usd: number;
  merchants: Array<{
    question_id: string;
    display_name: string;
    charges: unknown;
    cadence: unknown;
    noul: number;
    status: string;
    status_source: string;
    price_hike: unknown;
    trial: unknown;
    next_renewal: string | null;
    monthly_cents: number | null;
  }>;
  drafts: Array<{ merchant_key: string; tone: string; subject: string; body: string }>;
}): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  const { data: analysis, error } = await supabase
    .from('analyses')
    .insert({
      title: payload.title,
      jev_mode: payload.jev_mode,
      llm_mode: payload.llm_mode,
      date_from: payload.date_from,
      date_to: payload.date_to,
      monthly_total_cents: payload.monthly_total_cents,
      annual_total_cents: payload.annual_total_cents,
      jev_requests: payload.jev_requests,
      jev_cost_usd: payload.jev_cost_usd,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  const analysisId = analysis.id as string;

  const merchantRows = payload.merchants.map((m) => ({ ...m, analysis_id: analysisId }));
  const { data: insertedMerchants, error: mErr } = await supabase.from('merchants').insert(merchantRows).select('id, display_name');
  if (mErr) throw new Error(mErr.message);

  const keyToId = new Map<string, string>();
  for (const m of insertedMerchants ?? []) {
    keyToId.set(m.display_name, m.id);
  }
  const draftRows = payload.drafts
    .map((d) => {
      const merchantId = keyToId.get(d.merchant_key);
      return merchantId ? { merchant_id: merchantId, tone: d.tone, subject: d.subject, body: d.body } : null;
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);
  if (draftRows.length > 0) {
    const { error: dErr } = await supabase.from('drafts').insert(draftRows);
    if (dErr) throw new Error(dErr.message);
  }
}

// Clears browser state only. Anon DELETE on the saved-analysis tables is revoked on purpose,
// so there is no server-side delete from the browser.
export function clearLocalData(): void {
  localStorage.removeItem('sd_results');
  localStorage.removeItem('sd_drafts');
}

export async function listSavedAnalyses(): Promise<SavedAnalysis[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('analyses')
    .select('id, title, created_at, monthly_total_cents, annual_total_cents')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return (data ?? []) as SavedAnalysis[];
}

export { detectPriceHikes, detectTrialConversion, cadenceStats, monthlyEquivalentCents };
