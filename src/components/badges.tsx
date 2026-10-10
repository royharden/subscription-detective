import { CheckCircle2, HelpCircle, XCircle, TrendingUp, Sparkles } from 'lucide-react';
import { Status, StatusSource } from '@/lib/analysis';

export const STATUS_META: Record<Status, { label: string; chip: string; icon: typeof CheckCircle2; dot: string }> = {
  subscription: {
    label: 'Subscription',
    chip: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
    icon: CheckCircle2,
    dot: 'bg-emerald-500',
  },
  maybe: {
    label: 'Maybe - needs review',
    chip: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
    icon: HelpCircle,
    dot: 'bg-amber-500',
  },
  not_subscription: {
    label: 'Not a subscription',
    chip: 'bg-slate-200 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300',
    icon: XCircle,
    dot: 'bg-slate-400',
  },
};

export function StatusBadge({ status, source }: { status: Status; source: StatusSource }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span className={`chip ${meta.chip}`}>
      <Icon className="h-3.5 w-3.5" />
      {meta.label}
      {source === 'user' && <span className="ml-1 rounded bg-white/60 px-1 text-[10px] font-semibold dark:bg-slate-900/50">Set by you</span>}
    </span>
  );
}

export function PriceHikeChip({ percent }: { percent: number }) {
  return (
    <span className="chip bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300">
      <TrendingUp className="h-3.5 w-3.5" />
      Price hike +{percent.toFixed(1)}%
    </span>
  );
}

export function TrialChip({ date }: { date: string }) {
  return (
    <span className="chip bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
      <Sparkles className="h-3.5 w-3.5" />
      Trial converted on {formatDate(date)}
    </span>
  );
}

export function RenewsSoonChip() {
  return (
    <span className="chip bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300">
      <CheckCircle2 className="h-3.5 w-3.5" />
      Renews soon
    </span>
  );
}

export function formatDate(iso: string): string {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function ReplayBadge() {
  return (
    <span className="chip bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200">
      Replay: recorded Jev answers
    </span>
  );
}
