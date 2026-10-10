// Generates the fictional sample statement. All merchants are invented.
import { Charge, addDays } from './detection';

interface ScheduledCharge {
  date: string;
  amount: number; // dollars, negative = charge (out), positive = income
  description: string;
}

function on(day: number, month: number, description: string, amount: number): ScheduledCharge {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return { date: `2026-${mm}-${dd}`, amount, description };
}

function monthly(day: number, months: number[], description: string, amount: number): ScheduledCharge[] {
  return months.map((m) => on(day, m, description, amount));
}

export function buildSampleRows(): ScheduledCharge[] {
  const rows: ScheduledCharge[] = [];

  // Subscriptions
  rows.push(...monthly(14, [6, 7], 'STREAMLY.COM 866-555-0101', -15.49));
  rows.push(...monthly(14, [8, 9], 'STREAMLY.COM 866-555-0101', -17.99)); // price hike
  rows.push(...monthly(3, [6, 7, 8, 9], 'TUNEWAVE MUSIC PREMIUM', -10.99));
  rows.push(...monthly(7, [6, 7, 8, 9], 'CLOUDVAULT STORAGE 100GB', -2.99));
  rows.push(...monthly(1, [6, 7, 8, 9], 'FITFORGE GYM MEMBERSHIP', -39.99));
  rows.push(...monthly(9, [6, 7, 8, 9], 'DAILY LEDGER NEWS SUBSCRIPTION', -4.0));
  rows.push(...monthly(21, [6, 7, 8, 9], 'PROMPTPAL PRO AI WRITING', -20.0));
  // Trial converted: $0 on Jul 12, then full price Aug 12, Sep 12
  rows.push(on(12, 7, 'CODEMUSE AI TRIAL', 0));
  rows.push(on(12, 8, 'CODEMUSE AI CODEMUSE.COM', -19.0));
  rows.push(on(12, 9, 'CODEMUSE AI CODEMUSE.COM', -19.0));
  // Single annual renewal -> Maybe
  rows.push(on(18, 7, 'DOMAINNEST RENEWAL example-site.io', -14.99));

  // Decoys: recurring groceries (weekly, varying)
  const groceries = [
    [84.12, 61.7, 117.35, 72.44],
    [95.3, 58.12, 103.88, 66.05],
    [77.61, 122.4, 69.99, 88.2],
    [91.15, 64.78, 109.5, 73.31],
  ];
  groceries.forEach((month, mi) => {
    month.forEach((amt, wi) => {
      rows.push(on(6 + wi * 7, 6 + mi, 'FRESHCART MARKET #212', -amt));
    });
  });
  // Coffee several times a week
  const coffeeDays = [2, 5, 9, 12, 16, 19, 23, 26, 30];
  coffeeDays.forEach((d) => {
    rows.push(on(d, 6, 'BEAN THERE COFFEE SHOP', -5.75));
    rows.push(on(((d + 3) % 28) + 1, 7, 'BEAN THERE COFFEE SHOP', -6.1));
    rows.push(on(((d + 1) % 28) + 1, 8, 'BEAN THERE COFFEE SHOP', -5.5));
    rows.push(on(((d + 4) % 28) + 1, 9, 'BEAN THERE COFFEE SHOP', -5.95));
  });
  // Metro transit reload
  rows.push(...monthly(5, [6, 8], 'METRO TRANSIT CARD RELOAD', -50));
  rows.push(on(5, 7, 'METRO TRANSIT CARD RELOAD', -50));
  rows.push(on(6, 9, 'METRO TRANSIT CARD RELOAD', -50));
  // Fuel
  rows.push(on(4, 6, 'SHELL OIL 5743 GAS STATION', -42.18));
  rows.push(on(19, 6, 'CHEVRON 0092 FUEL', -38.55));
  rows.push(on(8, 7, 'SHELL OIL 5743 GAS STATION', -45.02));
  rows.push(on(23, 7, 'CHEVRON 0092 FUEL', -40.11));
  rows.push(on(12, 8, 'SHELL OIL 5743 GAS STATION', -44.76));
  rows.push(on(27, 8, 'CHEVRON 0092 FUEL', -39.9));
  rows.push(on(9, 9, 'SHELL OIL 5743 GAS STATION', -43.6));
  // Restaurants
  rows.push(on(6, 6, 'NORI ICHI SUSHI BAR', -38.4));
  rows.push(on(15, 6, 'LA PIAZZETTA TRATTORIA', -52.75));
  rows.push(on(24, 6, 'TACO RADIOS FOOD TRUCK', -14.2));
  rows.push(on(11, 7, 'NORI ICHI SUSHI BAR', -41.1));
  rows.push(on(20, 7, 'THE COPPER SKILLET', -29.85));
  rows.push(on(2, 8, 'LA PIAZZETTA TRATTORIA', -47.3));
  rows.push(on(18, 8, 'TACO RADIOS FOOD TRUCK', -12.9));
  rows.push(on(26, 8, 'NORI ICHI SUSHI BAR', -36.55));
  rows.push(on(5, 9, 'THE COPPER SKILLET', -31.2));
  // Online shops
  rows.push(on(10, 6, 'AMARA HOME DECOR SHOP', -67.99));
  rows.push(on(14, 7, 'VELOCITY GEAR OUTDOORS', -129.5));
  rows.push(on(22, 8, 'AMARA HOME DECOR SHOP', -23.4));
  rows.push(on(3, 9, 'PAGE ONE BOOKSTORE', -31.85));
  // Rent
  rows.push(...monthly(1, [6, 7, 8, 9], 'BRIGHTKEY PROPERTY MGMT RENT', -1850));
  // Payroll
  rows.push(...monthly(15, [6, 7, 8, 9], 'ACME DYNAMICS PAYROLL DIRECT DEP', 3200));
  rows.push(...monthly(30, [6, 7, 8], 'ACME DYNAMICS PAYROLL DIRECT DEP', 3200));
  // Refund
  rows.push(on(28, 7, 'VELOCITY GEAR OUTDOORS REFUND', 129.5));
  // A few one-off transfers
  rows.push(on(16, 6, 'TRANSFER TO SAVINGS X4421', -200));
  rows.push(on(16, 8, 'TRANSFER TO SAVINGS X4421', -200));

  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export function sampleCsvText(): string {
  const rows = buildSampleRows();
  const lines = ['Date,Description,Amount,Account'];
  for (const r of rows) {
    const desc = r.description.includes(',') ? `"${r.description}"` : r.description;
    lines.push(`${r.date},${desc},${r.amount.toFixed(2)},CHASE CHECKING ...4821`);
  }
  return lines.join('\n');
}

export function sampleCharges(): Charge[] {
  return buildSampleRows().map((r) => ({
    date: r.date,
    amountCents: Math.round(Math.abs(r.amount) * 100),
    descriptor: r.description,
  }));
}

export const SAMPLE_DATE_FROM = '2026-06-01';
export const SAMPLE_DATE_TO = '2026-09-30';
export { addDays };
