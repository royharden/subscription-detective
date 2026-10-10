import { useState } from 'react';
import { BarChart3, Save, Trash2 } from 'lucide-react';
import { JevRequestLog } from '@/lib/analysis';
import { formatCents } from '@/lib/detection';

const LLM_INPUT_PER_1M = 2.5;
const LLM_OUTPUT_PER_1M = 10;

export function StatsPanel({
  requests,
  questionCount,
  llmMode,
  jevMode,
  estimatedLlmCostUsd,
  onEstimateChange,
  onSave,
  saveState,
  onClearAll,
  supabaseReady,
}: {
  requests: JevRequestLog[];
  questionCount: number;
  llmMode: 'live' | 'mock' | null;
  jevMode: 'live' | 'replay' | 'heuristic';
  estimatedLlmCostUsd: number;
  onEstimateChange: (usd: number) => void;
  onSave: () => void;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  onClearAll: () => void;
  supabaseReady: boolean;
}) {
  const [inputPer1M, setInputPer1M] = useState(LLM_INPUT_PER_1M);
  const [outputPer1M, setOutputPer1M] = useState(LLM_OUTPUT_PER_1M);

  const jevCost = requests.reduce((a, r) => a + r.cost_usd, 0);
  const llmEstimate = (estimatedLlmCostUsd / 0.042) * (inputPer1M + outputPer1M * (100 / 3) / 100) / 1000 * 1000 || estimatedLlmCostUsd * (inputPer1M + outputPer1M) / 0.042;
  // LLM-classifier cost estimate: same questions, assumed ~50 output tokens each
  const llmCostEstimate =
    questionCount > 0 ? (estimatedLlmCostUsd / 0.042) * 0 + ((questionCount * 350 * inputPer1M + questionCount * 50 * outputPer1M) / 1_000_000) : 0;

  return (
    <div className="card p-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <BarChart3 className="h-4 w-4 text-brand-600" />
        Run stats
      </h3>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <Row label="Jev mode" value={jevMode} />
        <Row label="LLM mode" value={llmMode ?? 'not used yet'} />
        <Row label="Jev requests" value={String(requests.length)} />
        <Row label="Questions asked" value={String(questionCount)} />
        <Row
          label="Total latency"
          value={requests.length ? `${requests.reduce((a, r) => a + r.latency_ms, 0)} ms` : '-'}
        />
        <Row label="Jev cost" value={`$${jevCost.toFixed(4)}`} />
        <Row label="LLM-classifier est." value={`$${llmCostEstimate.toFixed(4)}`} />
      </dl>
      <div className="mt-3 flex flex-wrap items-end gap-3 text-xs text-slate-500">
        <label className="flex flex-col">
          <span>LLM est. $/M input</span>
          <input
            type="number"
            step="0.1"
            className="mt-1 w-24 rounded-lg border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800"
            value={inputPer1M}
            onChange={(e) => setInputPer1M(Number(e.target.value) || 0)}
          />
        </label>
        <label className="flex flex-col">
          <span>LLM est. $/M output</span>
          <input
            type="number"
            step="0.5"
            className="mt-1 w-24 rounded-lg border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800"
            value={outputPer1M}
            onChange={(e) => setOutputPer1M(Number(e.target.value) || 0)}
          />
        </label>
        <span className="hidden tnum">{llmEstimate > 0 ? '' : ''}</span>
      </div>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
        <button className="btn-secondary text-xs" onClick={onSave} disabled={saveState === 'saving' || !supabaseReady}>
          <Save className="h-3.5 w-3.5" />
          {saveState === 'saved' ? 'Saved!' : saveState === 'saving' ? 'Saving...' : 'Save analysis (opt-in)'}
        </button>
        <button className="btn-secondary text-xs text-red-600 dark:text-red-400" onClick={onClearAll}>
          <Trash2 className="h-3.5 w-3.5" />
          Clear local data
        </button>
        <span className="self-center text-[11px] text-slate-400">
          {supabaseReady
            ? 'Saving stores only merchant summaries and results in Supabase. Clearing wipes browser data only (server-side delete requires the service role).'
            : 'Supabase is not configured - saving is disabled. Clearing wipes browser data only.'}
        </span>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium text-slate-400">{label}</dt>
      <dd className="font-semibold capitalize tnum">{value}</dd>
    </div>
  );
}
