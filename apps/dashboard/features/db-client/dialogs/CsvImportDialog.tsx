/**
 * Import a CSV/TSV file into an existing table. Parses client-side (RFC-ish),
 * lets the user map CSV columns → table columns (auto-matched by name), then
 * inserts row-by-row through the parameterized editRow op — no string-built SQL.
 * Capped to keep a runaway file from melting the IPC channel.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Upload } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import * as api from '../api.js';
import { parseCsv, rowsToRecords } from '../grid/csv-import.js';

const MAX_ROWS = 5000;

type Delimiter = ',' | '\t' | ';';

export function CsvImportDialog({
  open,
  connKey,
  schema,
  table,
  onClose,
  onDone,
}: {
  open: boolean;
  connKey: string;
  schema?: string;
  table: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation('dbClient');
  const cid = connKey;
  const [fileName, setFileName] = useState('');
  const [text, setText] = useState('');
  const [delimiter, setDelimiter] = useState<Delimiter>(',');
  const [hasHeader, setHasHeader] = useState(true);
  const [columns, setColumns] = useState<string[]>([]);
  const [mapping, setMapping] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; errors: number } | null>(null);
  const cancelRef = useRef(false);

  // Pull the table's columns to drive the mapping dropdowns.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void api
      .describeTable(cid, schema ?? '', table)
      .then((info) => {
        if (live) setColumns(info.columns.map((c) => c.name));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open, cid, schema, table]);

  const rows = useMemo(() => (text ? parseCsv(text, delimiter) : []), [text, delimiter]);
  const headers = useMemo<string[]>(() => {
    if (rows.length === 0) return [];
    return hasHeader ? rows[0] : rows[0].map((_, i) => `col${i + 1}`);
  }, [rows, hasHeader]);
  const dataRows = useMemo(() => (hasHeader ? rows.slice(1) : rows), [rows, hasHeader]);

  // Auto-map each CSV header to a same-named column (case-insensitive) once both
  // the headers and the table columns are known.
  useEffect(() => {
    if (headers.length === 0) return;
    setMapping(
      headers.map((h) => {
        const hit = columns.find((c) => c.toLowerCase() === h.toLowerCase());
        return hit ?? '';
      }),
    );
  }, [headers, columns]);

  async function pickFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setFileName(file.name);
    if (/\.tsv$/i.test(file.name)) setDelimiter('\t');
    setText(await file.text());
  }

  async function runImport(): Promise<void> {
    const records = rowsToRecords(mapping, dataRows).filter((r) => Object.keys(r).length > 0);
    if (records.length === 0) {
      toast.error(t('import.title'), { description: t('import.nothing') });
      return;
    }
    const capped = records.slice(0, MAX_ROWS);
    cancelRef.current = false;
    setImporting(true);
    setProgress({ done: 0, total: capped.length, errors: 0 });
    let errors = 0;
    for (let i = 0; i < capped.length; i += 1) {
      if (cancelRef.current) break;
      try {
        await api.editRow({ connectionId: cid, op: 'insert', schema, table, values: capped[i] });
      } catch {
        errors += 1;
      }
      if (i % 25 === 0 || i === capped.length - 1) setProgress({ done: i + 1, total: capped.length, errors });
    }
    setImporting(false);
    const inserted = capped.length - errors;
    if (errors > 0) toast.warning(t('import.title'), { description: t('import.doneErrors', { ok: inserted, errors }) });
    else toast.success(t('import.title'), { description: t('import.done', { n: inserted }) });
    onDone();
    onClose();
  }

  const mappedCount = mapping.filter(Boolean).length;
  const previewRows = dataRows.slice(0, 5);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !importing && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('import.title')} · {table}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <label className="cursor-pointer">
                <Upload className="mr-1.5 h-3 w-3" />
                {fileName || t('import.selectFile')}
                <input
                  type="file"
                  accept=".csv,.tsv,.txt"
                  className="hidden"
                  onChange={(e) => void pickFile(e.target.files?.[0])}
                />
              </label>
            </Button>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
              {t('import.hasHeader')}
            </label>
            <select
              className="ml-auto rounded border bg-background px-2 py-1 text-xs"
              value={delimiter}
              onChange={(e) => setDelimiter(e.target.value as Delimiter)}
              title={t('import.delimiter')}
            >
              <option value=",">{t('import.comma')}</option>
              <option value={'\t'}>{t('import.tab')}</option>
              <option value=";">{t('import.semicolon')}</option>
            </select>
          </div>

          {headers.length > 0 && (
            <>
              <div className="text-xs text-muted-foreground">
                {t('import.rowsParsed', { n: dataRows.length })}
                {dataRows.length > MAX_ROWS ? ` · ${t('import.capped', { n: MAX_ROWS })}` : ''}
              </div>
              <div className="max-h-56 overflow-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/60">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium">{t('import.csvColumn')}</th>
                      <th className="px-2 py-1 text-left font-medium">{t('import.targetColumn')}</th>
                      <th className="px-2 py-1 text-left font-medium">{t('import.sample')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {headers.map((h, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-1 font-mono">{h}</td>
                        <td className="px-2 py-1">
                          <select
                            className="w-full rounded border bg-background px-1.5 py-0.5"
                            value={mapping[i] ?? ''}
                            onChange={(e) =>
                              setMapping((m) => {
                                const next = [...m];
                                next[i] = e.target.value;
                                return next;
                              })
                            }
                          >
                            <option value="">{t('import.skip')}</option>
                            {columns.map((c) => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                          </select>
                        </td>
                        <td className="max-w-[14rem] truncate px-2 py-1 font-mono text-muted-foreground">
                          {previewRows.map((r) => r[i] ?? '').slice(0, 3).join(' · ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {progress && (
            <div className="text-xs text-muted-foreground">
              {progress.done}/{progress.total}
              {progress.errors > 0 ? ` · ${t('import.errorsN', { n: progress.errors })}` : ''}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          {importing ? (
            <Button variant="ghost" size="sm" onClick={() => (cancelRef.current = true)}>
              {t('import.cancel')}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('import.cancel')}
            </Button>
          )}
          <Button size="sm" onClick={() => void runImport()} disabled={importing || mappedCount === 0 || dataRows.length === 0}>
            {importing && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
            {t('import.import')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
