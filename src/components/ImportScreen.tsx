import { useCallback, useState } from 'react';
import { Upload, FileText, ShieldCheck, AlertTriangle } from 'lucide-react';
import Papa from 'papaparse';
import { ColumnMapping, sniffMapping, parseCsv, ParseResult } from '@/lib/csv';

const MAX_BYTES = 5 * 1024 * 1024;

export interface ImportResult {
  text: string;
  parse: ParseResult;
  fileName: string;
}

export function ImportScreen({
  onImported,
  onTrySample,
}: {
  onImported: (r: ImportResult) => void;
  onTrySample: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingText, setPendingText] = useState<{ text: string; fileName: string } | null>(null);
  const [sniff, setSniff] = useState<ReturnType<typeof sniffMapping> | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [preview, setPreview] = useState<Record<string, string>[]>([]);
  const [dateOrder, setDateOrder] = useState<'mdy' | 'dmy'>('mdy');
  const [sign, setSign] = useState<'negative-is-debit' | 'positive-is-debit'>('negative-is-debit');

  const finish = useCallback(
    (text: string, fileName: string, mapping: ColumnMapping, order: 'mdy' | 'dmy', signConvention: 'negative-is-debit' | 'positive-is-debit') => {
      const parse = parseCsv(text, mapping, order, signConvention);
      if (parse.rowCount === 0) {
        setError('No usable rows were found. Check the column mapping and sign convention.');
        return;
      }
      onImported({ text, parse, fileName });
    },
    [onImported],
  );

  const handleFile = useCallback((file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) {
      setError('File is larger than 5 MB.');
      return;
    }
    if (!/\.csv$/i.test(file.name)) {
      setError('Please choose a .csv file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      const first = Papa.parse<Record<string, string>>(text, { header: true, preview: 25, skipEmptyLines: true });
      const hs = (first.meta.fields ?? []).filter(Boolean);
      const rows = first.data;
      const s = sniffMapping(hs, rows);
      setHeaders(hs);
      setPreview(rows.slice(0, 5));
      if (s.confident) {
        finish(text, file.name, s.mapping, s.dateOrder === 'dmy' ? 'dmy' : 'mdy', 'negative-is-debit');
      } else {
        setPendingText({ text, fileName: file.name });
        setSniff(s);
        setDateOrder(s.dateOrder === 'dmy' ? 'dmy' : 'mdy');
      }
    };
    reader.readAsText(file);
  }, [finish]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`card flex flex-col items-center justify-center gap-4 border-2 border-dashed p-12 text-center transition ${
          dragOver ? 'border-brand-500 bg-brand-50/50 dark:bg-brand-900/10' : 'border-slate-300 dark:border-slate-700'
        }`}
      >
        <div className="rounded-full bg-brand-100 p-4 dark:bg-brand-900/40">
          <Upload className="h-8 w-8 text-brand-600 dark:text-brand-400" />
        </div>
        <div>
          <p className="text-lg font-semibold">Drag and drop your bank or card statement CSV</p>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">or pick a file. Max 5 MB. Parsed entirely in your browser.</p>
        </div>
        <label className="btn-primary cursor-pointer">
          <FileText className="h-4 w-4" />
          Choose CSV file
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
        </label>
        <button onClick={onTrySample} className="btn-secondary">
          Try the fictional sample
        </button>
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="mt-6 flex items-start gap-3 rounded-xl bg-slate-100 p-4 text-sm text-slate-600 dark:bg-slate-900 dark:text-slate-400">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400" />
        <p>
          <span className="font-semibold text-slate-800 dark:text-slate-200">Privacy.</span> Your CSV is parsed entirely in your
          browser. The raw file and raw rows are never uploaded or stored on a server. Only a minimal per-merchant summary
          (cleaned merchant name, charge dates, amounts) is sent to the detection service - account numbers, balances, card
          digits, and memos are dropped before anything leaves your browser. Analyses live in your browser by default.
        </p>
      </div>

      {pendingText && sniff && (
        <div className="card mt-6 p-6">
          <h3 className="text-base font-semibold">Confirm column mapping</h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            We could not confidently detect every column. Check the preview and adjust.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  {headers.map((h) => (
                    <th key={h} className="px-2 py-1.5 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((row, i) => (
                  <tr key={i} className="border-b border-slate-100 dark:border-slate-800">
                    {headers.map((h) => (
                      <td key={h} className="px-2 py-1.5 tnum">
                        {row[h]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {(
              [
                ['Date column', 'date'],
                ['Description column', 'description'],
                ['Amount column', 'amount'],
              ] as Array<[string, keyof ColumnMapping]>
            ).map(([label, field]) => (
              <label key={field} className="block text-sm">
                <span className="mb-1 block font-medium">{label}</span>
                <select
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                  value={(sniff.mapping[field] as string) ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSniff((prev) => {
                      if (!prev) return prev;
                      const mapping = { ...prev.mapping, [field]: v === '' ? null : v };
                      return { ...prev, mapping };
                    });
                  }}
                >
                  <option value="">- none -</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Date order (ambiguous dates)</span>
              <select
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                value={dateOrder}
                onChange={(e) => setDateOrder(e.target.value as 'mdy' | 'dmy')}
              >
                <option value="mdy">MM/DD/YYYY</option>
                <option value="dmy">DD/MM/YYYY</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Sign convention</span>
              <select
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                value={sign}
                onChange={(e) => setSign(e.target.value as 'negative-is-debit' | 'positive-is-debit')}
              >
                <option value="negative-is-debit">Charges are negative</option>
                <option value="positive-is-debit">Charges are positive</option>
              </select>
            </label>
          </div>
          <button
            className="btn-primary mt-5"
            onClick={() => {
              if (!sniff?.mapping.date || (!sniff.mapping.amount && !sniff.mapping.debit)) {
                setError('Please choose at least a date column and an amount column.');
                return;
              }
              finish(pendingText.text, pendingText.fileName, sniff.mapping, dateOrder, sign);
            }}
          >
            Import and analyze
          </button>
        </div>
      )}
    </div>
  );
}
