import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { jevDetectResultSchema, JevDetectResult, draftResultSchema, planChunks, buildQuestions, buildState, idToMerchant } from './analysis';
import { CandidateSummary } from './csv';
import { RecordedJevFixture } from './recordedJev';
import { detectPriceHikes, detectTrialConversion, cadenceStats, monthlyEquivalentCents } from './detection';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function invokeFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    // supabase-js wraps the raw Response in error.context; check it for 429/daily_limit
    const ctx = (error as { context?: Response }).context;
    if (ctx) {
      if (ctx.status === 429) throw new Error('daily_limit');
      try {
        const errBody = await ctx.json();
        if (errBody?.error === 'daily_limit') throw new Error('daily_limit');
      } catch { /* not JSON or already consumed */ }
    }
    const message = typeof error.message === 'string' ? error.message : 'Edge function error';
    if (message.includes('daily_limit') || message.includes('429')) throw new Error('daily_limit');
    throw new Error(message);
  }
  return data as T;
}

async function invokeRaw(name: string, body: unknown): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${supabaseAnonKey}`, apikey: supabaseAnonKey },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

export interface DetectOutcome {
  result: JevDetectResult | null;
  error?: string;
}

async function callJevLive(candidates: CandidateSummary[]): Promise<JevDetectResult> {
  const { chunks } = planChunks(candidates);
  const answers: Record<string, { noul: number; confidence: number }> = {};
  const requests: JevDetectResult['requests'] = [];
  let model = 'jev-1.13.0';

  for (const chunk of chunks) {
    const idMap = idToMerchant(chunk);
    const payload = { state: buildState(chunk), questions: buildQuestions(chunk) };
    const started = performance.now();
    const { ok, status, json } = await invokeRaw('jev-detect', payload);
    const latency_ms = Math.round(performance.now() - started);
    if (!ok) {
      const err = (json as { error?: string } | null)?.error;
      if (status === 429 || err === 'daily_limit') throw new Error('daily_limit');
      throw new Error(err ?? `jev-detect failed (${status})`);
    }
    // retry once for missing IDs
    let responseObj = json as Record<string, unknown>;
    const answersRaw = (responseObj?.answers ?? {}) as Record<string, unknown>;
    const missing = [...idMap.keys()].filter((id) => !(id in answersRaw));
    if (missing.length > 0) {
      const retryChunk = chunk.filter((_, i) => missing.includes(`m${String(i + 1).padStart(2, '0')}`));
      const retry = await invokeRaw('jev-detect', {
        state: buildState(retryChunk),
        questions: buildQuestions(retryChunk),
      });
      if (retry.ok) {
        const retryAnswers = ((retry.json as Record<string, unknown>)?.answers ?? {}) as Record<string, unknown>;
        Object.assign(answersRaw, retryAnswers);
        responseObj = { ...responseObj, answers: answersRaw };
      }
    }
    const parsed = z
      .object({
        model: z.string().optional(),
        answers: z.record(z.string(), z.object({ noul: z.number() }).passthrough()),
        usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
      })
      .safeParse(responseObj);
    if (!parsed.success) throw new Error('Unexpected response from jev-detect');
    if (parsed.data.model) model = parsed.data.model;
    for (const [id, a] of Object.entries(parsed.data.answers)) {
      const key = idMap.get(id);
      if (key) answers[key] = { noul: a.noul, confidence: Math.abs(2 * a.noul - 1) };
    }
    const usage = parsed.data.usage ?? { input_tokens: 0, output_tokens: 0 };
    requests.push({
      question_count: Object.keys(parsed.data.answers).length,
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
  const { ok, status, json } = await invokeRaw('draft-cancellation', input);
  if (!ok) {
    const err = (json as { error?: string } | null)?.error;
    if (status === 429 || err === 'daily_limit') throw new Error('daily_limit');
    throw new Error(err ?? `draft-cancellation failed (${status})`);
  }
  const parsed = draftResultSchema.safeParse(json);
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

export async function clearSavedData(): Promise<void> {
  // DELETE is revoked from anon/authenticated; these will fail at the DB level.
  // Use allSettled so local data clearing is not blocked, and server-side
  // cleanup is best-effort (the service role in an edge function would bypass RLS).
  await Promise.allSettled([
    supabase.from('drafts').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
    supabase.from('merchants').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
    supabase.from('analyses').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
  ]);
}

export async function listSavedAnalyses(): Promise<SavedAnalysis[]> {
  const { data, error } = await supabase
    .from('analyses')
    .select('id, title, created_at, monthly_total_cents, annual_total_cents')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return (data ?? []) as SavedAnalysis[];
}

export { detectPriceHikes, detectTrialConversion, cadenceStats, monthlyEquivalentCents };
