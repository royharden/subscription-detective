import { ArrowRight, ShieldCheck } from 'lucide-react';
import type { ImportResult } from './ImportScreen';

export function HeroBody({
  onImported,
  onTrySample,
}: {
  onImported: (r: ImportResult) => void;
  onTrySample: () => void;
}) {
  return (
    <section className="mx-auto max-w-4xl px-4 pb-16 pt-10 text-center sm:pt-16">
      <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
        Subscription Detective
      </h1>
      <p className="mx-auto mt-4 max-w-2xl text-lg text-slate-600 dark:text-slate-400">
        Find every recurring charge hiding in your statement. Import a bank or card CSV, and the detective
        surfaces subscriptions, price hikes, and free trials that quietly converted - then drafts cancellation
        emails you can copy.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <a href="#import" className="btn-primary">
          Import CSV
          <ArrowRight className="h-4 w-4" />
        </a>
        <button className="btn-secondary" onClick={onTrySample}>
          Try the sample
        </button>
      </div>
      <div className="mx-auto mt-10 grid max-w-3xl grid-cols-1 gap-4 text-left sm:grid-cols-3">
        {[
          ['Cadence math in code', 'Intervals, medians, totals, price hikes, and trial conversions are computed in code - the LLM never does date math.'],
          ['One batched request', 'A single fast yes/no Jev question per merchant, batched into one request instead of one call per merchant.'],
          ['Never sends email', 'Drafts are text you copy into your own mail app. Nothing is ever sent.'],
        ].map(([title, body]) => (
          <div key={title} className="card p-4">
            <p className="text-sm font-semibold">{title}</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{body}</p>
          </div>
        ))}
      </div>
      <div id="import" className="mt-12 flex items-center justify-center gap-2 text-xs text-slate-400">
        <ShieldCheck className="h-4 w-4 text-brand-500" />
        Parsed entirely in your browser - scroll down to import.
      </div>
    </section>
  );
}
