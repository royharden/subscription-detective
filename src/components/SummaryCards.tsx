import { DollarSign, CalendarClock, Users, TrendingUp, Sparkles, HelpCircle } from 'lucide-react';
import { AnalysisTotals } from '@/lib/analysis';
import { formatCents } from '@/lib/detection';

export function SummaryCards({ totals }: { totals: AnalysisTotals }) {
  const cards = [
    {
      icon: DollarSign,
      label: 'Monthly total',
      value: formatCents(totals.monthlyTotalCents),
      sub: 'confirmed subscriptions only',
      cls: 'text-brand-600 bg-brand-100 dark:text-brand-400 dark:bg-brand-900/40',
    },
    {
      icon: CalendarClock,
      label: 'Annual total',
      value: formatCents(totals.annualTotalCents),
      sub: 'monthly x 12',
      cls: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/40',
    },
    {
      icon: Users,
      label: 'Subscriptions',
      value: String(totals.subscriptionCount),
      sub: 'confirmed recurring',
      cls: 'text-emerald-600 bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-900/40',
    },
    {
      icon: TrendingUp,
      label: 'Price hikes',
      value: formatCents(totals.hikeExtraPerYearCents),
      sub: 'extra per year from hikes',
      cls: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/40',
    },
    {
      icon: Sparkles,
      label: 'Trials converted',
      value: String(totals.trialCount),
      sub: 'free trials that started billing',
      cls: 'text-violet-600 bg-violet-100 dark:text-violet-400 dark:bg-violet-900/40',
    },
    {
      icon: HelpCircle,
      label: 'Possible extra',
      value: formatCents(totals.possibleExtraMonthlyCents),
      sub: `${totals.maybeCount} maybe item${totals.maybeCount === 1 ? '' : 's'} per month`,
      cls: 'text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900/40',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <div key={c.label} className="card p-4">
            <div className={`inline-flex rounded-lg p-2 ${c.cls}`}>
              <Icon className="h-4 w-4" />
            </div>
            <p className="mt-3 text-xl font-bold tnum">{c.value}</p>
            <p className="text-xs font-medium text-slate-600 dark:text-slate-300">{c.label}</p>
            <p className="mt-0.5 text-[11px] text-slate-400">{c.sub}</p>
          </div>
        );
      })}
    </div>
  );
}
