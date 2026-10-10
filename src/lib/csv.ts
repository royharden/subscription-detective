import Papa from 'papaparse';
import { z } from 'zod';
import { Charge, cadenceStats, normalizeMerchant } from './detection';

export const parsedRowSchema = z.object({
  date: z.string(),
  description: z.string(),
  amountCents: z.number().int(),
});

export type ParsedRow = z.infer<typeof parsedRowSchema>;

export interface ColumnMapping {
  date: string;
  description: string;
  amount: string | null; // single signed amount column
  debit: string | null; // or debit/credit pair
  credit: string | null;
}

export interface ParseResult {
  rows: ParsedRow[];
  headers: string[];
  mapping: ColumnMapping;
  skipped: number;
  dateOrder: 'mdy' | 'dmy';
  signConvention: 'negative-is-debit' | 'positive-is-debit';
  rowCount: number;
  dateFrom: string | null;
  dateTo: string | null;
}

export interface SniffedMapping {
  mapping: ColumnMapping;
  confident: boolean;
  dateOrder: 'mdy' | 'dmy' | 'ambiguous';
}

function parseAmount(raw: string): number | null {
  if (!raw) return null;
  let s = raw.trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$€£¥,\s]/g, '');
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const cents = Math.round(parseFloat(s) * 100);
  return negative ? -cents : cents;
}

const DATE_RE = /^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/;

export function parseDate(raw: string, order: 'mdy' | 'dmy'): string | null {
  const s = raw.trim();
  // ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = DATE_RE.exec(s);
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const p1 = m[1];
  const p2 = m[2];
  const p3 = m[3];
  if (p1.length === 4) {
    // yyyy-mm-dd
    return `${p1}-${p2.padStart(2, '0')}-${p3.padStart(2, '0')}`;
  }
  const year = p3.length === 2 ? `20${p3}` : p3;
  const a = parseInt(p1, 10);
  const b = parseInt(p2, 10);
  if (a > 12 && b <= 12) return `${year}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
  if (b > 12 && a <= 12) return `${year}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
  return order === 'mdy'
    ? `${year}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`
    : `${year}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
}

const DATE_HEADER_RE = /date|posted|transaction.?date|time/i;
const DESC_HEADER_RE = /descri|merchant|payee|name|detail|narrative/i;
const AMOUNT_HEADER_RE = /^amount|amount$|value|total/i;
const DEBIT_HEADER_RE = /debit|withdraw|paid|out|charge/i;
const CREDIT_HEADER_RE = /credit|deposit|paid.?in|in\b/i;

export function sniffMapping(headers: string[], sampleRows: Record<string, string>[]): SniffedMapping {
  const dateCol = headers.find((h) => DATE_HEADER_RE.test(h)) ?? null;
  const descCol = headers.find((h) => DESC_HEADER_RE.test(h)) ?? null;
  let amountCol: string | null = headers.find((h) => AMOUNT_HEADER_RE.test(h)) ?? null;
  const debitCol = headers.find((h) => DEBIT_HEADER_RE.test(h)) ?? null;
  const creditCol = headers.find((h) => CREDIT_HEADER_RE.test(h)) ?? null;

  // fall back to value sniffing for amount
  if (!amountCol) {
    const candidate = headers.find((h) => {
      if (h === dateCol) return false;
      return sampleRows.some((r) => parseAmount(r[h] ?? '') !== null);
    });
    amountCol = candidate ?? null;
  }

  // date order sniffing: check if any parsed value has day > 12 under either interpretation
  let dateOrder: 'mdy' | 'dmy' | 'ambiguous' = 'mdy';
  if (dateCol) {
    let ambiguous = false;
    let sawFirst = false;
    for (const r of sampleRows.slice(0, 20)) {
      const v = r[dateCol] ?? '';
      const m = DATE_RE.exec(v.trim());
      if (m && m[1].length !== 4) {
        const a = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        if (a > 12 && b <= 12) {
          dateOrder = 'dmy';
          ambiguous = false;
          break;
        }
        if (b > 12 && a <= 12) {
          dateOrder = 'mdy';
          ambiguous = false;
          break;
        }
        if (!sawFirst) {
          ambiguous = true;
          sawFirst = true;
        }
      }
    }
    if (ambiguous && dateOrder !== 'dmy' && dateOrder !== 'mdy') dateOrder = 'ambiguous';
  }

  const confident =
    !!dateCol && !!descCol && (!!amountCol || (!!debitCol && !!creditCol)) && dateOrder !== 'ambiguous';

  return {
    mapping: { date: dateCol ?? '', description: descCol ?? '', amount: amountCol, debit: debitCol, credit: creditCol },
    confident,
    dateOrder,
  };
}

const EXCLUDED_PATTERNS = [
  /payroll|salary|direct dep/i,
  /transfer|zelle|venmo cashout/i,
  /refund|reversal|credit memo/i,
  /interest paid|interest earned/i,
];

export function isExcludedRow(description: string, amountCents: number): boolean {
  if (amountCents < 0) return true; // income under negative-is-debit
  return EXCLUDED_PATTERNS.some((re) => re.test(description));
}

export function parseCsv(
  text: string,
  mapping: ColumnMapping,
  dateOrder: 'mdy' | 'dmy',
  signConvention: 'negative-is-debit' | 'positive-is-debit',
): ParseResult {
  const result = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const headers = (result.meta.fields ?? []).filter(Boolean);
  const rows: ParsedRow[] = [];
  let skipped = 0;

  for (const raw of result.data) {
    const dateRaw = raw[mapping.date] ?? '';
    const desc = (raw[mapping.description] ?? '').trim();
    let amountCents: number | null = null;
    if (mapping.amount) {
      const v = parseAmount(raw[mapping.amount] ?? '');
      if (v !== null) amountCents = v;
    } else if (mapping.debit && mapping.credit) {
      const d = parseAmount(raw[mapping.debit] ?? '');
      const c = parseAmount(raw[mapping.credit] ?? '');
      if (d !== null && d !== 0) amountCents = signConvention === 'negative-is-debit' ? -Math.abs(d) : Math.abs(d);
      else if (c !== null && c !== 0) amountCents = signConvention === 'negative-is-debit' ? Math.abs(c) : -Math.abs(c);
    }
    const date = parseDate(dateRaw, dateOrder);
    if (!date || !desc || amountCents === null) {
      skipped++;
      continue;
    }
    const parsed = parsedRowSchema.safeParse({ date, description: desc, amountCents });
    if (!parsed.success) {
      skipped++;
      continue;
    }
    rows.push(parsed.data);
  }

  const dates = rows.map((r) => r.date).sort();
  return {
    rows,
    headers,
    mapping,
    skipped,
    dateOrder,
    signConvention,
    rowCount: rows.length,
    dateFrom: dates[0] ?? null,
    dateTo: dates[dates.length - 1] ?? null,
  };
}

export interface MerchantGroup {
  key: string;
  displayName: string;
  charges: Charge[];
  descriptors: string[];
}

// Merges descriptors like "CODEMUSE AI TRIAL" and "CODEMUSE AI CODEMUSE.COM"
// into one merchant when they share the same core name.
function canonicalMerchant(normalized: string): string {
  let s = normalized;
  s = s.replace(/\b(TRIAL|RENEWAL)\b/g, ' ');
  s = s.replace(/\b[A-Z0-9-]+\.(COM|NET|ORG|IO|CO|AI)\b/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s || normalized;
}

export function groupMerchants(rows: ParsedRow[], signConvention: 'negative-is-debit' | 'positive-is-debit'): MerchantGroup[] {
  const groups = new Map<string, MerchantGroup>();
  for (const r of rows) {
    const chargeCents = signConvention === 'negative-is-debit' ? -r.amountCents : r.amountCents;
    if (isExcludedRow(r.description, chargeCents)) continue;
    const key = canonicalMerchant(normalizeMerchant(r.description));
    let g = groups.get(key);
    if (!g) {
      g = { key, displayName: key, charges: [], descriptors: [] };
      groups.set(key, g);
    }
    g.charges.push({ date: r.date, amountCents: chargeCents, descriptor: r.description.toUpperCase().trim() });
    if (!g.descriptors.includes(r.description.toUpperCase().trim()) && g.descriptors.length < 3) {
      g.descriptors.push(r.description.toUpperCase().trim());
    }
  }
  for (const g of groups.values()) {
    g.charges.sort((a, b) => a.date.localeCompare(b.date));
  }
  return [...groups.values()].sort((a, b) => b.charges.length - a.charges.length);
}

export interface CandidateSummary {
  key: string;
  name: string;
  sample_descriptors: string[];
  charges: Array<{ date: string; amount: number }>;
  cadence: string;
  median_interval_days: number | null;
  amount_variation: string;
}

const VARIATION_LABELS: Array<{ maxCv: number; label: string }> = [
  { maxCv: 0.01, label: 'none' },
  { maxCv: 0.05, label: 'minimal' },
  { maxCv: 0.35, label: 'moderate' },
];

export function toCandidateSummary(g: MerchantGroup): CandidateSummary {
  const stats = cadenceStats(g.charges);
  const cv = stats.coefficientOfVariation;
  const stepChange =
    g.charges.length >= 3 &&
    stats.amountMinCents !== stats.amountMaxCents &&
    (() => {
      const last = g.charges[g.charges.length - 1].amountCents;
      const prev = g.charges[g.charges.length - 2].amountCents;
      return last !== prev;
    })();
  let variation = 'large';
  if (cv !== null) {
    for (const v of VARIATION_LABELS) {
      if (cv <= v.maxCv) {
        variation = v.label;
        break;
      }
    }
    if (variation === 'large' && stepChange && cv <= 0.2) {
      variation = 'none until a step change';
    }
  }
  return {
    key: g.key,
    name: g.displayName,
    sample_descriptors: g.descriptors.slice(0, 3),
    charges: g.charges.slice(-12).map((c) => ({ date: c.date, amount: c.amountCents / 100 })),
    cadence: stats.cadence,
    median_interval_days: stats.medianIntervalDays,
    amount_variation: variation,
  };
}

export interface CandidateDecision {
  isCandidate: boolean;
  reason: string;
}

export function isCandidateMerchant(g: MerchantGroup): CandidateDecision {
  if (g.charges.length >= 2) return { isCandidate: true, reason: `${g.charges.length} charges` };
  const single = g.charges[0];
  if (single) {
    if (/TRIAL|RENEWAL/i.test(single.descriptor)) return { isCandidate: true, reason: 'looks like a trial or renewal' };
    if (single.amountCents >= 500 && single.amountCents <= 10000)
      return { isCandidate: true, reason: 'single charge in subscription price range' };
  }
  return { isCandidate: false, reason: 'single charge, not trial-like' };
}

export function estimateTokens(obj: unknown): number {
  return JSON.stringify(obj).length / 4;
}

export const MAX_MERCHANTS_PER_CHUNK = 60;
export const MAX_STATE_TOKENS = 20000;
