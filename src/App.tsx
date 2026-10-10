import { useCallback, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Moon, Sun, AlertTriangle, Info } from 'lucide-react';
import { HeroBody } from '@/components/HeroBody';
import { ImportScreen, ImportResult } from '@/components/ImportScreen';
import { PipelineStrip, PipelineStep } from '@/components/PipelineStrip';
import { SummaryCards } from '@/components/SummaryCards';
import { SubscriptionsTable } from '@/components/SubscriptionsTable';
import { Timeline } from '@/components/Timeline';
import { MerchantDrawer } from '@/components/MerchantDrawer';
import { StatsPanel } from '@/components/StatsPanel';
import { ReplayBadge } from '@/components/badges';
import { MerchantResult, Status, computeTotals, analyzeMerchants, JevRequestLog } from '@/lib/analysis';
import { groupMerchants, toCandidateSummary, isCandidateMerchant } from '@/lib/csv';
import { runDetection } from '@/lib/supabaseClient';
import { createHash } from '@/lib/hash';
import { formatCents } from '@/lib/detection';
import { sampleCsvText } from '@/lib/sampleData';
import recordedFixtureRaw from '@/lib/recorded-jev.json';
import { recordedJevSchema, RecordedJevFixture } from '@/lib/recordedJev';

const recordedFixture = recordedJevSchema.parse(recordedFixtureRaw) as RecordedJevFixture;

type Phase = 'import' | 'analyzing' | 'results';

export default function App() {
  const [phase, setPhase] = useState<Phase>('import');
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [parseInfo, setParseInfo] = useState<ImportResult | null>(null);
  const [results, setResults] = useState<MerchantResult[]>([]);
  const [requests, setRequests] = useState<JevRequestLog[]>([]);
  const [jevMode, setJevMode] = useState<'live' | 'replay' | 'heuristic'>('live');
  const [llmMode, setLlmMode] = useState<'live' | 'mock' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openMerchant, setOpenMerchant] = useState<MerchantResult | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [isSample, setIsSample] = useState(false);

  const applyTheme = useCallback((d: boolean) => {
    setDark(d);
    document.documentElement.classList.toggle('dark', d);
  }, []);

  const runAnalysis = useCallback(
    async (imp: ImportResult, sample: boolean) => {
      setPhase('analyzing');
      setNotice(null);
      setParseInfo(imp);
      setIsSample(sample);

      const groups = groupMerchants(imp.parse.rows, imp.parse.signConvention);
      const candidateGroups = groups.filter((g) => isCandidateMerchant(g).isCandidate);
      const candidates = candidateGroups.map(toCandidateSummary);
      const summariesHash = createHash(JSON.stringify(candidates));

      const outcome = await runDetection(candidates, recordedFixture, summariesHash, sample);
      if (outcome.error === 'daily_limit') {
        setNotice('Daily demo limit reached - switching to Replay mode');
        setJevMode('replay');
      } else if (outcome.error) {
        setNotice(`Detection fell back to a labeled heuristic classifier: ${outcome.error}`);
      }

      const mode = outcome.result?.mode ?? 'heuristic';
      setJevMode(mode);
      setRequests(outcome.result?.requests ?? []);

      const idMap = new Map<string, string>();
      candidates.forEach((c, i) => idMap.set(`m${String(i + 1).padStart(2, '0')}`, c.key));
      const analyzed = analyzeMerchants(groups, outcome.result?.answers_by_merchant ?? {}, idMap, mode);
      setResults(analyzed);
      setPhase('results');
    },
    [],
  );

  const onImported = useCallback(
    (imp: ImportResult) => {
      runAnalysis(imp, false);
    },
    [runAnalysis],
  );

  const onTrySample = useCallback(() => {
    const text = sampleCsvText();
    const mapping = { date: 'Date', description: 'Description', amount: 'Amount', debit: null, credit: null };
    const parse = {
      rows: [] as never[],
    };
    // Reuse the shared parse path
    import('@/lib/csv').then(({ parseCsv }) => {
      const full = parseCsv(text, mapping, 'mdy', 'negative-is-debit');
      runAnalysis({ text, parse: full, fileName: 'transactions-sample.csv' }, true);
    });
    void parse;
  }, [runAnalysis]);

  const totals = useMemo(() => computeTotals(results), [results]);

  const pipelineSteps: PipelineStep[] = useMemo(
    () => [
      { label: 'CSV', detail: parseInfo ? `${parseInfo.parse.rowCount} rows, in browser` : 'in browser', done: !!parseInfo },
      { label: 'Merchants', detail: results.length ? `${results.length} grouped` : 'grouping', done: results.length > 0 },
      {
        label: 'Cadence',
        detail: 'computed in code',
        done: results.length > 0,
      },
      {
        label: `1 Jev request`,
        detail: requests.length ? `${requests.reduce((a, r) => a + r.question_count, 0)} questions` : jevMode === 'replay' ? 'recorded answers' : 'pending',
        done: requests.length > 0 || jevMode === 'replay',
      },
      { label: 'Money math', detail: 'computed in code', done: results.length > 0 },
      { label: 'Results', detail: phase === 'results' ? 'done' : '...', done: phase === 'results' },
    ],
    [parseInfo, results.length, requests, jevMode, phase],
  );

  const handleOverride = useCallback((key: string, status: Status | null) => {
    setResults((prev) =>
      prev.map((r) => {
        if (r.group.key !== key) return r;
        if (status === null) {
          const recomputed = analyzeOneDefault(r);
          return { ...r, status: recomputed, statusSource: r.statusSource === 'user' ? 'jev' : r.statusSource };
        }
        return { ...r, status, statusSource: 'user' };
      }),
    );
    setOpenMerchant((prev) => (prev && prev.group.key === key ? { ...prev, status: status ?? prev.status, statusSource: status ? 'user' : prev.statusSource } : prev));
  }, []);

  const handleSave = useCallback(async () => {
    setSaveState('saving');
    try {
      const { saveAnalysis } = await import('@/lib/supabaseClient');
      const drafts = JSON.parse(localStorage.getItem('sd_drafts') ?? '[]') as Array<{
        merchant_key: string;
        tone: string;
        subject: string;
        body: string;
      }>;
      await saveAnalysis({
        title: parseInfo?.fileName ?? 'Untitled analysis',
        jev_mode: jevMode,
        llm_mode: llmMode ?? 'mock',
        date_from: parseInfo?.parse.dateFrom ?? '',
        date_to: parseInfo?.parse.dateTo ?? '',
        monthly_total_cents: totals.monthlyTotalCents,
        annual_total_cents: totals.annualTotalCents,
        jev_requests: requests,
        jev_cost_usd: requests.reduce((a, r) => a + r.cost_usd, 0),
        merchants: results.map((r) => ({
          question_id: r.questionId,
          display_name: r.group.displayName,
          charges: r.group.charges,
          cadence: { cadence: r.stats.cadence, median_interval_days: r.stats.medianIntervalDays },
          noul: r.noul,
          status: r.status,
          status_source: r.statusSource,
          price_hike: r.priceHike,
          trial: r.trial,
          next_renewal: r.renewal,
          monthly_cents: r.monthlyCents,
        })),
        drafts,
      });
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }, [parseInfo, jevMode, llmMode, totals, requests, results]);

  const handleClearAll = useCallback(async () => {
    localStorage.removeItem('sd_results');
    localStorage.removeItem('sd_drafts');
    try {
      const { clearSavedData } = await import('@/lib/supabaseClient');
      await clearSavedData();
    } catch {
      // ignore network issues; local data is cleared regardless
    }
    setResults([]);
    setParseInfo(null);
    setPhase('import');
  }, []);

  if (phase === 'import') {
    return (
      <div className={dark ? 'dark' : ''}>
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
          <Hero dark={dark} onToggleDark={() => applyTheme(!dark)} onImported={onImported} onTrySample={onTrySample} />
        </div>
      </div>
    );
  }

  return (
    <div className={dark ? 'dark' : ''}>
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
        <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-2">
              <Search className="h-5 w-5 text-brand-600" />
              <span className="font-bold">Subscription Detective</span>
              {jevMode === 'replay' && <ReplayBadge />}
            </div>
            <div className="flex items-center gap-2">
              <button
                className="btn-secondary px-3 py-1.5 text-xs"
                onClick={() => {
                  setPhase('import');
                }}
              >
                New import
              </button>
              <button
                className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 dark:hover:bg-slate-800"
                onClick={() => applyTheme(!dark)}
                aria-label="Toggle dark mode"
              >
                {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl space-y-6 px-4 py-6">
          {notice && (
            <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {notice}
            </div>
          )}
          {isSample && (
            <div className="flex items-start gap-2 rounded-xl bg-slate-100 p-3 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-400">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              All merchants in this sample statement are fictional.
            </div>
          )}

          <PipelineStrip steps={pipelineSteps} />
          <SummaryCards totals={totals} />
          <SubscriptionsTable results={results} onOverride={handleOverride} onOpen={setOpenMerchant} />
          <Timeline results={results} />
          <StatsPanel
            requests={requests}
            questionCount={requests.reduce((a, r) => a + r.question_count, 0)}
            llmMode={llmMode}
            jevMode={jevMode}
            estimatedLlmCostUsd={0.042}
            onEstimateChange={() => {}}
            onSave={handleSave}
            saveState={saveState}
            onClearAll={handleClearAll}
          />
        </main>

        <AnimatePresence>
          {openMerchant && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <MerchantDrawer
                result={openMerchant}
                llmModeKnown={llmMode !== null}
                onClose={() => setOpenMerchant(null)}
                onLlmMode={setLlmMode}
                onLimitReached={() => setNotice('Daily demo limit reached - draft generation fell back to templates.')}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function analyzeOneDefault(r: MerchantResult): Status {
  return r.status;
}

function Hero({
  dark,
  onToggleDark,
  onImported,
  onTrySample,
}: {
  dark: boolean;
  onToggleDark: () => void;
  onImported: (r: ImportResult) => void;
  onTrySample: () => void;
}) {
  return (
    <>
      <nav className="flex items-center justify-between px-4 py-4 sm:px-8">
        <div className="flex items-center gap-2">
          <Search className="h-6 w-6 text-brand-600" />
          <span className="text-lg font-bold">Subscription Detective</span>
        </div>
        <button
          className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 dark:hover:bg-slate-800"
          onClick={onToggleDark}
          aria-label="Toggle dark mode"
        >
          {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </button>
      </nav>
      <HeroBody onImported={onImported} onTrySample={onTrySample} />
    </>
  );
}
