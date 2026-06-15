/**
 * Regression panel (modal): replay the active collection's verified requests
 * with no LLM and show pass/fail per request, plus run history. Mutating
 * methods are skipped unless explicitly opted in (with a warning).
 */
import { useEffect, useState } from 'react';
import { Loader2, Play, CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import { cn } from '../../lib/utils.js';
import * as api from './api.js';
import type { ApiRegressionRun, RunReport } from './types.js';

interface Props {
  projectId: number;
  collectionId: number | null;
  envId: number | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onRequestsChanged: () => void;
}

export function RegressionPanel({ projectId, collectionId, envId, open, onOpenChange, onRequestsChanged }: Props) {
  const [running, setRunning] = useState(false);
  const [includeMutating, setIncludeMutating] = useState(false);
  const [report, setReport] = useState<RunReport | null>(null);
  const [runs, setRuns] = useState<ApiRegressionRun[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = () => {
    if (collectionId == null) return;
    api.listRuns(projectId, collectionId).then(setRuns).catch(() => { /* ignore */ });
  };
  useEffect(() => { if (open) loadRuns(); }, [open, collectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    if (collectionId == null) return;
    setRunning(true); setError(null); setReport(null);
    try {
      const r = await api.runCollection(projectId, collectionId, { envId: envId ?? undefined, includeMutating });
      setReport(r);
      loadRuns();
      onRequestsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Regression — Run all</DialogTitle></DialogHeader>

        <div className="flex items-center gap-3">
          <Button size="sm" disabled={running || collectionId == null} onClick={run} className="gap-1">
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Run all
          </Button>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={includeMutating} onChange={(e) => setIncludeMutating(e.target.checked)} />
            Include mutating (POST/PUT/DELETE)
          </label>
          {includeMutating && <span className="text-[10px] text-amber-500">⚠ will hit write endpoints</span>}
        </div>

        {error && <div className="text-xs text-red-500">{error}</div>}

        {report && (
          <div className="space-y-1">
            {report.passed === 0 && report.failed === 0 ? (
              <div className="text-xs text-amber-500">
                Nothing ran — no verified requests. Send a request and click "Set as expected" first.
              </div>
            ) : (
              <div className="text-xs">
                <span className="text-emerald-500 font-medium">{report.passed} passed</span>
                {' · '}<span className="text-red-500 font-medium">{report.failed} failed</span>
                {' · '}<span className="text-muted-foreground">{report.skipped} skipped</span>
              </div>
            )}
            <div className="max-h-60 overflow-auto border rounded">
              {report.results.map((r) => (
                <div key={r.requestId} className="flex items-center gap-2 px-2 py-1 text-xs border-b border-border/30">
                  {r.skipped
                    ? <MinusCircle className="h-3.5 w-3.5 text-muted-foreground/50" />
                    : r.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : <XCircle className="h-3.5 w-3.5 text-red-500" />}
                  <span className="font-mono w-12 text-muted-foreground">{r.method}</span>
                  <span className="truncate flex-1">{r.name}</span>
                  <span className={cn('font-mono', r.ok ? 'text-emerald-500' : 'text-muted-foreground')}>
                    {r.expected ?? '—'}{r.actual != null ? `/${r.actual}` : ''}
                  </span>
                  {r.reason && <span className="text-[10px] text-muted-foreground truncate max-w-[40%]" title={r.reason}>{r.reason}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {runs.length > 0 && (
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-1">History</div>
            <div className="space-y-0.5 max-h-32 overflow-auto">
              {runs.map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-[11px] font-mono">
                  <span className={r.status === 'passed' ? 'text-emerald-500' : 'text-red-500'}>{r.status}</span>
                  <span className="text-muted-foreground">{r.passed}/{r.total}</span>
                  <span className="text-muted-foreground/60">{r.finished_at ?? r.created_at}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
