import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { MerchantResult } from '@/lib/analysis';
import { formatCents } from '@/lib/detection';
import { formatDate } from './badges';
import { CalendarClock } from 'lucide-react';

const COLORS = ['#10b981', '#0ea5e9', '#f59e0b', '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#6366f1'];

export function Timeline({ results }: { results: MerchantResult[] }) {
  const monthly = useMemo(() => {
    const byMonth = new Map<string, number>();
    const byMerchantMonth = new Map<string, Map<string, number>>();
    for (const r of results.filter((x) => x.status === 'subscription')) {
      for (const c of r.group.charges) {
        const month = c.date.slice(0, 7);
        byMonth.set(month, (byMonth.get(month) ?? 0) + c.amountCents);
        if (!byMerchantMonth.has(month)) byMerchantMonth.set(month, new Map());
        const m = byMerchantMonth.get(month)!;
        m.set(r.group.displayName, (m.get(r.group.displayName) ?? 0) + c.amountCents);
      }
    }
    return [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, total]) => {
        const row: Record<string, string | number> = { month, total: total / 100 };
        for (const [merchant, cents] of byMerchantMonth.get(month) ?? []) {
          row[merchant] = cents / 100;
        }
        return row;
      });
  }, [results]);

  const merchants = useMemo(() => {
    const names = new Set<string>();
    for (const row of monthly) {
      for (const k of Object.keys(row)) {
        if (k !== 'month' && k !== 'total') names.add(k);
      }
    }
    return [...names];
  }, [monthly]);

  const upcoming = useMemo(() => {
    return results
      .filter((r) => r.renewal && r.status === 'subscription')
      .map((r) => ({ renewal: r.renewal!, name: r.group.displayName, amount: r.stats.amountMedianCents }))
      .filter((x) => {
        const d = new Date(x.renewal + 'T00:00:00Z').getTime();
        const now = Date.now();
        return d >= now - 86400000 && d <= now + 30 * 86400000;
      })
      .sort((a, b) => a.renewal.localeCompare(b.renewal))
      .slice(0, 8);
  }, [results]);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="card p-5 lg:col-span-2">
        <h3 className="text-sm font-semibold">Subscription charges by month</h3>
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthly}>
              <XAxis dataKey="month" tick={{ fontSize: 12 }} tickFormatter={(v: string) => formatDate(v + '-01').slice(0, 3)} />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={(v: number) => `$${v}`} />
              <Tooltip
                formatter={(value) => formatCents(Math.round(Number(value ?? 0) * 100))}
                labelFormatter={(label) => formatDate(String(label) + '-01')}
                contentStyle={{ borderRadius: 12, fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {merchants.map((m, i) => (
                <Bar key={m} dataKey={m} stackId="a" fill={COLORS[i % COLORS.length]} radius={i === merchants.length - 1 ? [4, 4, 0, 0] : undefined} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="card p-5">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <CalendarClock className="h-4 w-4 text-brand-600" />
          Renewals in the next 30 days
        </h3>
        <ul className="mt-3 space-y-2">
          {upcoming.map((u) => (
            <li key={u.name + u.renewal} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60">
              <div>
                <p className="font-medium">{u.name}</p>
                <p className="text-xs text-slate-500">{formatDate(u.renewal)}</p>
              </div>
              <span className="tnum text-sm font-semibold">{formatCents(u.amount)}</span>
            </li>
          ))}
          {upcoming.length === 0 && <li className="px-3 py-2 text-sm text-slate-400">No renewals in the next 30 days.</li>}
        </ul>
      </div>
    </div>
  );
}
