export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual' | 'irregular';

export interface Charge {
  date: string; // ISO yyyy-mm-dd
  amountCents: number; // positive = money out (a charge)
  descriptor: string;
}

export interface CadenceStats {
  intervals: number[];
  medianIntervalDays: number | null;
  spread: number | null;
  amountMinCents: number;
  amountMaxCents: number;
  amountMedianCents: number;
  coefficientOfVariation: number | null;
  cadence: Cadence;
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00Z');
  const db = new Date(b + 'T00:00:00Z');
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function normalizeMerchant(description: string): string {
  let s = description.toUpperCase().trim();
  // strip card prefixes
  s = s.replace(/^(POS|SQ|PAYPAL|VISA|MC|AMEX|TST\*|SQ \*|PAYPAL \*)\s*\*?\s*/g, '');
  s = s.replace(/\bTST\*\s*/g, '');
  // strip store numbers / reference codes
  s = s.replace(/#\d+/g, '');
  // strip store numbers like " STORE 1234" / " 1234" trailing digits
  s = s.replace(/\s+STORE\s+\d+/g, '');
  // strip phone numbers
  s = s.replace(/\b\d{3}[- ]?\d{3}[- ]?\d{4}\b/g, '');
  // strip long digit runs (reference codes)
  s = s.replace(/\s+\d{4,}\b/g, '');
  // strip trailing city suffixes and trailing whitespace/punctuation
  s = s.replace(/\s+[A-Z]{2}$/, '');
  s = s.replace(/[\s.\-]+$/, '');
  return s.trim() || description.toUpperCase().trim();
}

const CADENCE_RANGES: Array<{ label: Cadence; min: number; max: number }> = [
  { label: 'weekly', min: 6, max: 8 },
  { label: 'biweekly', min: 13, max: 16 },
  { label: 'monthly', min: 26, max: 35 },
  { label: 'quarterly', min: 85, max: 95 },
  { label: 'annual', min: 355, max: 375 },
];

export function cadenceLabel(medianInterval: number | null): Cadence {
  if (medianInterval === null || Number.isNaN(medianInterval)) return 'irregular';
  for (const r of CADENCE_RANGES) {
    if (medianInterval >= r.min && medianInterval <= r.max) return r.label;
  }
  return 'irregular';
}

export function cadenceStats(charges: Charge[]): CadenceStats {
  const sorted = [...charges].sort((a, b) => a.date.localeCompare(b.date));
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    intervals.push(daysBetween(sorted[i - 1].date, sorted[i].date));
  }
  const amounts = sorted.map((c) => c.amountCents);
  const med = median(amounts);
  const mean = amounts.reduce((a, b) => a + b, 0) / (amounts.length || 1);
  const variance = amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / (amounts.length || 1);
  const sd = Math.sqrt(variance);
  const medianInterval = intervals.length > 0 ? median(intervals) : null;
  return {
    intervals,
    medianIntervalDays: medianInterval,
    spread: intervals.length > 0 ? Math.max(...intervals) - Math.min(...intervals) : null,
    amountMinCents: amounts.length ? Math.min(...amounts) : 0,
    amountMaxCents: amounts.length ? Math.max(...amounts) : 0,
    amountMedianCents: med || 0,
    coefficientOfVariation: amounts.length && mean !== 0 ? sd / Math.abs(mean) : null,
    cadence: cadenceLabel(medianInterval),
  };
}

export function monthlyEquivalentCents(amountCents: number, cadence: Cadence): number | null {
  switch (cadence) {
    case 'weekly':
      return Math.round((amountCents * 52) / 12);
    case 'biweekly':
      return Math.round((amountCents * 26) / 12);
    case 'monthly':
      return amountCents;
    case 'quarterly':
      return Math.round(amountCents / 3);
    case 'annual':
      return Math.round(amountCents / 12);
    default:
      return null;
  }
}

export interface PriceHike {
  oldCents: number;
  newCents: number;
  date: string;
  percentChange: number;
  extraPerYearCents: number;
}

export function detectPriceHikes(charges: Charge[]): PriceHike | null {
  const sorted = [...charges].sort((a, b) => a.date.localeCompare(b.date));
  for (let i = sorted.length - 1; i >= 1; i--) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const pct = ((cur.amountCents - prev.amountCents) / prev.amountCents) * 100;
    if (pct >= 1 && cur.amountCents - prev.amountCents >= 50) {
      // must persist on the next charge, or be the latest charge
      const next = sorted[i + 1];
      if (!next || next.amountCents === cur.amountCents) {
        const monthly = monthlyEquivalentCents(cur.amountCents, cadenceStats(charges).cadence);
        const monthlyOld = monthlyEquivalentCents(prev.amountCents, cadenceStats(charges).cadence);
        const extraYear =
          monthly !== null && monthlyOld !== null ? (monthly - monthlyOld) * 12 : 0;
        return {
          oldCents: prev.amountCents,
          newCents: cur.amountCents,
          date: cur.date,
          percentChange: pct,
          extraPerYearCents: extraYear,
        };
      }
    }
  }
  return null;
}

export function detectTrialConversion(charges: Charge[]): { convertedOn: string; fullPriceCents: number } | null {
  const sorted = [...charges].sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const aIsTrialish = (a.amountCents >= 0 && a.amountCents <= 100) || /TRIAL/i.test(a.descriptor);
    const gap = daysBetween(a.date, b.date);
    if (aIsTrialish && gap >= 6 && gap <= 32) {
      return { convertedOn: b.date, fullPriceCents: b.amountCents };
    }
  }
  return null;
}

export function nextRenewal(charges: Charge[], stats: CadenceStats): string | null {
  if (stats.cadence === 'irregular' || stats.medianIntervalDays === null) return null;
  const sorted = [...charges].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 1];
  if (!last) return null;
  return addDays(last.date, Math.round(stats.medianIntervalDays));
}

export function formatCents(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export function daysUntil(date: string, today = new Date().toISOString().slice(0, 10)): number {
  return daysBetween(today, date);
}
