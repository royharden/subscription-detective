import { z } from 'zod';
import { Charge, Cadence, cadenceStats, detectPriceHikes, detectTrialConversion, monthlyEquivalentCents, nextRenewal } from './detection';
import { MerchantGroup, toCandidateSummary, isCandidateMerchant, estimateTokens, MAX_MERCHANTS_PER_CHUNK, MAX_STATE_TOKENS, CandidateSummary } from './csv';

export type Status = 'subscription' | 'maybe' | 'not_subscription';
export type StatusSource = 'jev' | 'heuristic' | 'user' | 'replay';

export const jevResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(
    z.string(),
    z.union([
      z.object({ type: z.literal('noul'), noul: z.number() }),
      z.object({ type: z.string(), noul: z.number().optional() }).passthrough(),
    ]),
  ),
});

export type JevAnswer = z.infer<typeof jevResponseSchema>['answers'][string];

export interface JevRequestLog {
  question_count: number;
  usage: { input_tokens: number; output_tokens: number };
  latency_ms: number;
  cost_usd: number;
}

export interface JevDetectResult {
  answers_by_merchant: Record<string, { noul: number; confidence: number }>;
  model: string;
  requests: JevRequestLog[];
  mode: 'live' | 'replay' | 'heuristic';
}

export const jevDetectResultSchema = z.object({
  answers_by_merchant: z.record(z.string(), z.object({ noul: z.number(), confidence: z.number() })),
  model: z.string(),
  requests: z.array(
    z.object({
      question_count: z.number(),
      usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
      latency_ms: z.number(),
      cost_usd: z.number(),
    }),
  ),
  mode: z.enum(['live', 'replay', 'heuristic']),
});

export const draftResultSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  mode: z.enum(['live', 'mock']),
});

export interface MerchantResult {
  group: MerchantGroup;
  stats: ReturnType<typeof cadenceStats>;
  noul: number;
  confidence: number;
  status: Status;
  statusSource: StatusSource;
  monthlyCents: number | null;
  priceHike: ReturnType<typeof detectPriceHikes>;
  trial: ReturnType<typeof detectTrialConversion>;
  renewal: string | null;
  questionId: string;
  rawJev: unknown;
}

export function statusFromNoul(
  noul: number,
  cadence: Cadence,
  chargeCount: number,
): Status {
  if (chargeCount <= 1) return 'maybe';
  if (noul >= 0.7 && cadence !== 'irregular') return 'subscription';
  if (noul >= 0.4 && noul < 0.7) return 'maybe';
  if (noul >= 0.7 && cadence === 'irregular') return 'maybe';
  return 'not_subscription';
}

export function heuristicStatus(stats: ReturnType<typeof cadenceStats>, charges: Charge[]): Status {
  if (charges.length <= 1) return 'maybe';
  const stableAmounts = stats.coefficientOfVariation !== null && stats.coefficientOfVariation <= 0.15;
  if (stats.cadence !== 'irregular' && stableAmounts) return 'subscription';
  if (stats.cadence !== 'irregular') return 'maybe';
  return 'not_subscription';
}

export interface ChunkPlan {
  chunks: CandidateSummary[][];
  estimatedTokens: number;
}

export function planChunks(candidates: CandidateSummary[]): ChunkPlan {
  const chunks: CandidateSummary[][] = [];
  let current: CandidateSummary[] = [];
  let currentTokens = 0;
  for (const c of candidates) {
    const t = estimateTokens(c);
    if (current.length >= MAX_MERCHANTS_PER_CHUNK || currentTokens + t > MAX_STATE_TOKENS) {
      if (current.length) chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(c);
    currentTokens += t;
  }
  if (current.length) chunks.push(current);
  return { chunks, estimatedTokens: Math.round(candidates.reduce((a, c) => a + estimateTokens(c), 0)) };
}

export function buildQuestions(summaries: CandidateSummary[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  summaries.forEach((s, i) => {
    const qid = `m${String(i + 1).padStart(2, '0')}`;
    questions[qid] = {
      type: 'noul',
      instructions: `Is the merchant \`${qid}\` in \`merchants\` (${s.name}) a recurring subscription or membership that bills automatically for ongoing access?`,
      criteria: {
        true: 'Automatic renewals for ongoing access (streaming, software, AI tools, storage, news, gyms, memberships).',
        false: 'Separate purchases chosen each time (groceries, restaurants, fuel, shopping, transit top-ups, one-off payments).',
      },
    };
  });
  return questions;
}

export function buildState(summaries: CandidateSummary[]): Record<string, unknown> {
  const merchants: Record<string, unknown> = {};
  for (const s of summaries) {
    merchants[s.key] = {
      name: s.name,
      sample_descriptors: s.sample_descriptors,
      charges: s.charges,
      cadence: s.cadence,
      median_interval_days: s.median_interval_days,
      amount_variation: s.amount_variation,
    };
  }
  return { merchants };
}

export function idToMerchant(summaries: CandidateSummary[]): Map<string, string> {
  const map = new Map<string, string>();
  summaries.forEach((s, i) => map.set(`m${String(i + 1).padStart(2, '0')}`, s.key));
  return map;
}

export function analyzeMerchants(
  groups: MerchantGroup[],
  answers: Record<string, { noul: number; confidence: number }>,
  idMap: Map<string, string>,
  mode: 'live' | 'replay' | 'heuristic',
): MerchantResult[] {
  return groups.map((g) => {
    const decision = isCandidateMerchant(g);
    const stats = cadenceStats(g.charges);
    let noul = 0;
    let confidence = 1;
    let statusSource: StatusSource = 'heuristic';
    let raw: unknown = null;
    if (decision.isCandidate) {
      const merchantKey = [...idMap.entries()].find(([, k]) => k === g.key)?.[0];
      const answer = merchantKey ? answers[merchantKey] : undefined;
      if (answer) {
        noul = answer.noul;
        confidence = answer.confidence;
        statusSource = mode === 'replay' ? 'replay' : 'jev';
        raw = { noul };
      } else {
        statusSource = 'heuristic';
      }
    }
    const status = statusSource === 'heuristic' ? heuristicStatus(stats, g.charges) : statusFromNoul(noul, stats.cadence, g.charges.length);
    const price = stats.amountMedianCents;
    const monthlyCents = status === 'subscription' ? monthlyEquivalentCents(price, stats.cadence) : null;
    return {
      group: g,
      stats,
      noul,
      confidence,
      status,
      statusSource,
      monthlyCents,
      priceHike: detectPriceHikes(g.charges),
      trial: detectTrialConversion(g.charges),
      renewal: nextRenewal(g.charges, stats),
      questionId: [...idMap.entries()].find(([, k]) => k === g.key)?.[0] ?? '',
      rawJev: raw,
    };
  });
}

export interface AnalysisTotals {
  monthlyTotalCents: number;
  annualTotalCents: number;
  subscriptionCount: number;
  maybeCount: number;
  possibleExtraMonthlyCents: number;
  hikeExtraPerYearCents: number;
  trialCount: number;
}

export function computeTotals(results: MerchantResult[]): AnalysisTotals {
  let monthlyTotalCents = 0;
  let possibleExtraMonthlyCents = 0;
  let subscriptionCount = 0;
  let maybeCount = 0;
  let hikeExtra = 0;
  let trialCount = 0;
  for (const r of results) {
    if (r.status === 'subscription' && r.monthlyCents !== null) {
      monthlyTotalCents += r.monthlyCents;
      subscriptionCount++;
    } else if (r.status === 'maybe') {
      const m = monthlyEquivalentCents(r.stats.amountMedianCents, r.stats.cadence);
      if (m !== null) possibleExtraMonthlyCents += m;
      maybeCount++;
    }
    if (r.status === 'subscription' && r.priceHike) {
      hikeExtra += r.priceHike.extraPerYearCents;
    }
    if (r.trial) trialCount++;
  }
  return {
    monthlyTotalCents,
    annualTotalCents: monthlyTotalCents * 12,
    subscriptionCount,
    maybeCount,
    possibleExtraMonthlyCents,
    hikeExtraPerYearCents: hikeExtra,
    trialCount,
  };
}
