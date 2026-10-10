import { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { MerchantResult, Status } from '@/lib/analysis';
import { StatusBadge, PriceHikeChip, TrialChip, RenewsSoonChip, formatDate } from './badges';
import { formatCents, daysUntil } from '@/lib/detection';

export function SubscriptionsTable({
  results,
  onOverride,
  onOpen,
}: {
  results: MerchantResult[];
  onOverride: (key: string, status: Status | null) => void;
  onOpen: (r: MerchantResult) => void;
}) {
  const [showExcluded, setShowExcluded] = useState(false);
  const subs = results.filter((r) => r.status === 'subscription');
  const maybes = results.filter((r) => r.status === 'maybe');
  const excluded = results.filter((r) => r.status === 'not_subscription');
  const rows = [...subs, ...maybes];

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">
              <th className="px-4 py-3 font-semibold">Merchant</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold">Cadence</th>
              <th className="px-4 py-3 font-semibold text-right">Price</th>
              <th className="px-4 py-3 font-semibold text-right">Monthly eq.</th>
              <th className="px-4 py-3 font-semibold">Next renewal</th>
              <th className="px-4 py-3 font-semibold">Flags</th>
              <th className="px-4 py-3 font-semibold">Jev</th>
              <th className="px-4 py-3 font-semibold">Override</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const renewalDays = r.renewal ? daysUntil(r.renewal) : null;
              return (
                <tr
                  key={r.group.key}
                  className="cursor-pointer border-b border-slate-100 transition hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40"
                  onClick={() => onOpen(r)}
                >
                  <td className="px-4 py-3 font-medium">{r.group.displayName}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} source={r.statusSource} />
                  </td>
                  <td className="px-4 py-3 capitalize">{r.stats.cadence}</td>
                  <td className="px-4 py-3 text-right tnum">{formatCents(r.stats.amountMedianCents)}</td>
                  <td className="px-4 py-3 text-right tnum">
                    {r.monthlyCents !== null ? formatCents(r.monthlyCents) : '-'}
                  </td>
                  <td className="px-4 py-3">{r.renewal ? formatDate(r.renewal) : '-'}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {r.priceHike && <PriceHikeChip percent={r.priceHike.percentChange} />}
                      {r.trial && <TrialChip date={r.trial.convertedOn} />}
                      {renewalDays !== null && renewalDays >= 0 && renewalDays <= 7 && <RenewsSoonChip />}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <ProbBar noul={r.noul} />
                  </td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <OverrideMenu current={r.status} onOverride={(s) => onOverride(r.group.key, s)} />
                  </td>
                  <td className="px-2 py-3">
                    <ExternalLink className="h-4 w-4 text-slate-400" />
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-sm text-slate-400">
                  No subscription candidates found in this statement.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {excluded.length > 0 && (
        <div className="border-t border-slate-200 dark:border-slate-800">
          <button
            className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-slate-600 transition hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800/40"
            onClick={() => setShowExcluded((v) => !v)}
          >
            {showExcluded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Not subscriptions ({excluded.length}) - excluded decoys
          </button>
          {showExcluded && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-left text-sm">
                <tbody>
                  {excluded.map((r) => (
                    <tr key={r.group.key} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="px-4 py-2.5 pl-10 font-medium text-slate-500 dark:text-slate-400">{r.group.displayName}</td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={r.status} source={r.statusSource} />
                      </td>
                      <td className="px-4 py-2.5 capitalize text-slate-500">{r.stats.cadence}</td>
                      <td className="px-4 py-2.5 text-right tnum text-slate-500">{formatCents(r.stats.amountMedianCents)}</td>
                      <td className="px-4 py-2.5 text-xs text-slate-400">{r.group.charges.length} charges</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProbBar({ noul }: { noul: number }) {
  const pct = Math.round(noul * 100);
  const color = noul >= 0.7 ? 'bg-emerald-500' : noul >= 0.4 ? 'bg-amber-500' : 'bg-slate-400';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tnum text-slate-500">{pct}%</span>
    </div>
  );
}

function OverrideMenu({ current, onOverride }: { current: Status; onOverride: (s: Status | null) => void }) {
  const [open, setOpen] = useState(false);
  const options: Array<{ value: Status | null; label: string }> = [
    { value: 'subscription', label: 'Subscription' },
    { value: 'maybe', label: 'Maybe' },
    { value: 'not_subscription', label: 'Not a subscription' },
    { value: null, label: 'Reset (use Jev)' },
  ];
  return (
    <div className="relative">
      <button
        className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        onClick={() => setOpen((v) => !v)}
      >
        Override
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-44 rounded-xl border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {options.map((o) => (
            <button
              key={o.label}
              className={`block w-full px-3 py-1.5 text-left text-xs transition hover:bg-slate-50 dark:hover:bg-slate-800 ${
                current === o.value ? 'font-semibold text-brand-600' : 'text-slate-600 dark:text-slate-300'
              }`}
              onClick={() => {
                onOverride(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
