import { Check } from 'lucide-react';

export interface PipelineStep {
  label: string;
  detail: string;
  done: boolean;
}

export function PipelineStrip({ steps }: { steps: PipelineStep[] }) {
  return (
    <div className="card overflow-x-auto p-4">
      <div className="flex min-w-max items-center gap-2">
        {steps.map((s, i) => (
          <div key={s.label} className="flex items-center gap-2">
            {i > 0 && <div className={`h-px w-6 ${s.done ? 'bg-brand-400' : 'bg-slate-300 dark:bg-slate-700'}`} />}
            <div
              className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition ${
                s.done
                  ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300'
                  : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'
              }`}
            >
              {s.done ? <Check className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5 rounded-full border-2 border-current" />}
              <span>{s.label}</span>
              <span className="text-[10px] font-normal opacity-70">{s.detail}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
