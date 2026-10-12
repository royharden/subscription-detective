import { useState } from 'react';
import { X, Copy, Download, Mail, Loader2 } from 'lucide-react';
import { MerchantResult } from '@/lib/analysis';
import { formatCents } from '@/lib/detection';
import { draftCancellation } from '@/lib/supabaseClient';
import { templateDraft } from '@/lib/draftTemplates';
import { StatusBadge, PriceHikeChip, TrialChip, formatDate as fmtDate } from './badges';

type Tone = 'polite' | 'firm' | 'refund';

export function MerchantDrawer({
  result,
  llmModeKnown,
  onClose,
  onLlmMode,
  onLimitReached,
}: {
  result: MerchantResult;
  llmModeKnown: boolean;
  onClose: () => void;
  onLlmMode: (mode: 'live' | 'mock') => void;
  onLimitReached: () => void;
}) {
  const [tone, setTone] = useState<Tone>('polite');
  const [draft, setDraft] = useState<{ subject: string; body: string; mode: 'live' | 'mock' } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [limitFallback, setLimitFallback] = useState(false);

  const lastCharge = result.group.charges[result.group.charges.length - 1];

  const generate = async () => {
    setLoading(true);
    setError(null);
    const input = {
      merchant: result.group.displayName,
      priceCents: result.stats.amountMedianCents,
      cadence: result.stats.cadence,
      lastChargeDate: lastCharge?.date ?? '',
      tone,
    };
    try {
      const d = await draftCancellation(input);
      setDraft(d);
      setLimitFallback(false);
      onLlmMode(d.mode);
    } catch (e) {
      if (e instanceof Error && e.message === 'daily_limit') {
        // Daily demo limit: fall back to the template draft and say so
        setDraft({ ...templateDraft(input), mode: 'mock' });
        setLimitFallback(true);
        onLlmMode('mock');
        onLimitReached();
      } else setError(e instanceof Error ? e.message : 'Could not draft the email.');
    } finally {
      setLoading(false);
    }
  };

  const fullText = draft ? `${draft.subject}\n\n${draft.body}` : '';

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold">{result.group.displayName}</h2>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <StatusBadge status={result.status} source={result.statusSource} />
              {result.priceHike && <PriceHikeChip percent={result.priceHike.percentChange} />}
              {result.trial && <TrialChip date={result.trial.convertedOn} />}
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-3 text-sm">
          <Stat label="Price" value={formatCents(result.stats.amountMedianCents)} />
          <Stat label="Cadence" value={result.stats.cadence} />
          <Stat label="Median interval" value={result.stats.medianIntervalDays ? `${Math.round(result.stats.medianIntervalDays)} days` : '-'} />
          <Stat label="Amount range" value={`${formatCents(result.stats.amountMinCents)} - ${formatCents(result.stats.amountMaxCents)}`} />
          <Stat label="Next renewal" value={result.renewal ? fmtDate(result.renewal) : '-'} />
          <Stat label="Jev probability" value={`${Math.round(result.noul * 100)}%`} />
        </div>

        <section className="mt-6">
          <h3 className="text-sm font-semibold">Charges</h3>
          <div className="mt-2 max-h-52 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800">
            <table className="w-full text-left text-xs">
              <tbody>
                {result.group.charges.map((c, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    <td className="px-3 py-1.5 tnum">{fmtDate(c.date)}</td>
                    <td className="px-3 py-1.5 text-slate-500">{String(c.descriptor)}</td>
                    <td className="px-3 py-1.5 text-right tnum font-medium">{formatCents(c.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-6">
          <h3 className="text-sm font-semibold">Jev question and answer</h3>
          <p className="mt-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            Is the merchant <code className="rounded bg-slate-200 px-1 dark:bg-slate-700">{result.questionId || 'n/a'}</code> in{' '}
            <code className="rounded bg-slate-200 px-1 dark:bg-slate-700">merchants</code> ({result.group.displayName}) a recurring
            subscription or membership that bills automatically for ongoing access?
          </p>
          <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
            <span>
              Noul probability: <strong className="tnum text-slate-700 dark:text-slate-200">{result.noul.toFixed(2)}</strong>
              {' | '}Confidence |2p-1|: <strong className="tnum text-slate-700 dark:text-slate-200">{result.confidence.toFixed(2)}</strong>
            </span>
            {result.rawJev ? (
              <button className="underline" onClick={() => setShowRaw((v) => !v)}>
                {showRaw ? 'Hide' : 'Show'} raw Jev JSON
              </button>
            ) : null}
          </div>
          {showRaw && result.rawJev ? (
            <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-emerald-300">
              {JSON.stringify(result.rawJev, null, 2)}
            </pre>
          ) : null}
        </section>

        <section className="mt-6 rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Mail className="h-4 w-4 text-brand-600" />
            Draft cancellation email
          </h3>
          <div className="mt-3 flex gap-2">
            {(
              [
                ['polite', 'Polite'],
                ['firm', 'Firm'],
                ['refund', 'Refund latest charge'],
              ] as Array<[Tone, string]>
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setTone(v)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  tone === v
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button className="btn-primary mt-3" onClick={generate} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            {draft ? 'Regenerate draft' : 'Generate draft'}
          </button>
          {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
          {draft && (
            <div className="mt-4">
              <label className="text-xs font-medium text-slate-500">Subject</label>
              <input
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
                value={draft.subject}
                onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              />
              <label className="mt-3 block text-xs font-medium text-slate-500">Body</label>
              <textarea
                className="mt-1 h-56 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              />
              <div className="mt-3 flex gap-2">
                <button
                  className="btn-secondary"
                  onClick={async () => {
                    await navigator.clipboard.writeText(fullText);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  <Copy className="h-4 w-4" />
                  {copied ? 'Copied!' : 'Copy'}
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => {
                    const blob = new Blob([fullText], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `cancel-${result.group.displayName.toLowerCase().replace(/\s+/g, '-')}.txt`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  <Download className="h-4 w-4" />
                  Download .txt
                </button>
              </div>
              <p className="mt-3 text-xs text-slate-400">
                Subscription Detective never sends email. Copy this into your own mail app.
                {limitFallback
                  ? ' Daily demo limit reached - draft built from a template, not the live LLM.'
                  : llmModeKnown && draft.mode === 'mock' && ' Draft built from a template (mock LLM mode).'}
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
      <p className="text-[11px] font-medium text-slate-400">{label}</p>
      <p className="mt-0.5 text-sm font-semibold capitalize tnum">{value}</p>
    </div>
  );
}
