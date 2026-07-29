/**
 * Memory health card — the diagnostics strip at the top of the project
 * Memory tab. Answers the question that made the old pipeline feel dead:
 * "is this project actually learning anything?" Shows the last distillation
 * (when / which trigger / what landed), totals by category and provenance,
 * and the per-project automatic-memory toggle (projects.memory_enabled).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, CircleAlert, FlaskConical, RefreshCw, Sparkles, Loader2 } from 'lucide-react';
import { Switch } from '../../../components/ui/switch.js';
import { apiPatch, apiPost, useApi } from '../../../hooks/useApi.js';
import { cn, formatRelativeTime } from '../../../lib/utils.js';
import { CATEGORY_COLORS } from '../snapshot-types.js';
import { RestoreArchivedDialog } from './RestoreArchivedDialog.js';

interface DistillEntry {
  trigger: string;
  status: string;
  created: number;
  merged: number;
  skipped: number;
  error: string | null;
  /** Migration 185 diagnostics — why a pass came back the way it did. */
  detail?: string | null;
  provider?: string | null;
  model?: string | null;
  raw_chars?: number | null;
  duration_ms?: number | null;
  created_at: string;
}

interface DryRunResult {
  ok: boolean;
  step?: string;
  sessionId?: string;
  binding?: { provider: string; kind: string; model: string; resolvedFrom: string } | null;
  diag?: { outcome: string; httpStatus?: number; errorSnippet?: string; rawChars: number; latencyMs: number };
  rawResponse?: string;
  candidates?: Array<{ title: string; category: string }>;
  error?: string;
  durationMs?: number;
}

interface MemoryHealth {
  memory_enabled: boolean;
  last: DistillEntry | null;
  totals: {
    total: number;
    byCategory: Record<string, number>;
    bySource: Record<string, number>;
    archived?: number;
  };
}

export function MemoryHealthCard({ projectId }: { projectId: number }) {
  const { t } = useTranslation('projects');
  const { data, refetch } = useApi<MemoryHealth>(`/projects/${projectId}/memory/health`);
  const [consolidating, setConsolidating] = useState(false);
  const [consolidateMsg, setConsolidateMsg] = useState<string | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [dryRunning, setDryRunning] = useState(false);
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);

  if (!data) return null;
  const { last, totals } = data;

  const testDistill = async () => {
    setDryRunning(true);
    setDryRun(null);
    try {
      setDryRun(await apiPost<DryRunResult>(`/projects/${projectId}/memory/distill-dry-run`, {}));
    } catch (e) {
      setDryRun({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setDryRunning(false);
    }
  };

  const toggle = async (enabled: boolean) => {
    await apiPatch(`/projects/${projectId}`, { memory_enabled: enabled });
    refetch();
  };

  const consolidate = async () => {
    setConsolidating(true);
    setConsolidateMsg(null);
    try {
      const { results } = await apiPost<{ results: { merged: number; archived: number }[] }>(
        `/projects/${projectId}/memory/consolidate`, {},
      );
      const merged = results.reduce((s, r) => s + (r.merged ?? 0), 0);
      const archived = results.reduce((s, r) => s + (r.archived ?? 0), 0);
      setConsolidateMsg(
        merged || archived
          ? t('memory.health.consolidateDone', { merged, archived })
          : t('memory.health.consolidateNoop'),
      );
      refetch();
    } catch (e) {
      const status = (e as { status?: number }).status;
      setConsolidateMsg(status === 503 ? t('memory.health.consolidateUnavailable') : (e instanceof Error ? e.message : String(e)));
    } finally {
      setConsolidating(false);
    }
  };

  return (
    <div className="border-b bg-muted/30 px-3 py-2 space-y-1.5 shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <Brain className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="text-xs font-medium">{t('memory.health.title')}</span>
        <span className="text-[10px] text-muted-foreground">
          {t('memory.health.total', { count: totals.total })}
        </span>
        <button
          type="button"
          onClick={refetch}
          aria-label={t('memory.health.refresh')}
          className="p-1 rounded hover:bg-muted text-muted-foreground"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={consolidate}
          disabled={consolidating}
          aria-label={t('memory.health.consolidate')}
          title={t('memory.health.consolidate')}
          className="p-1 rounded hover:bg-muted text-muted-foreground disabled:opacity-50"
        >
          {consolidating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
        </button>
        <button
          type="button"
          onClick={testDistill}
          disabled={dryRunning}
          aria-label={t('memory.health.testDistill')}
          title={t('memory.health.testDistill')}
          className="p-1 rounded hover:bg-muted text-muted-foreground disabled:opacity-50"
        >
          {dryRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
        </button>
        {consolidateMsg && <span className="text-[10px] text-muted-foreground truncate">{consolidateMsg}</span>}
        <label className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
          {t('memory.toggle.label')}
          <Switch checked={data.memory_enabled} onCheckedChange={toggle} />
        </label>
      </div>

      <div className="text-[10px] text-muted-foreground flex items-center gap-1.5 min-w-0">
        {last ? (
          <>
            <span
              className={cn(
                'px-1 rounded font-medium',
                last.status === 'error'
                  ? 'bg-red-500/15 text-red-600 dark:text-red-300'
                  : last.status === 'empty' || last.status === 'skipped'
                    ? 'bg-muted'
                    : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
              )}
              title={[
                last.provider && last.model ? `${last.provider}/${last.model}` : null,
                last.raw_chars != null ? `raw ${last.raw_chars} chars` : null,
                last.duration_ms != null ? `${last.duration_ms}ms` : null,
              ].filter(Boolean).join(' · ') || undefined}
            >
              {last.detail ? `${last.status} · ${last.detail}` : last.status}
            </span>
            <span className="truncate">
              {last.trigger === 'consolidation'
                ? t('memory.health.lastConsolidation', {
                    when: formatRelativeTime(last.created_at),
                    merged: last.merged,
                    archived: last.skipped,
                  })
                : t('memory.health.lastDistill', {
                    when: formatRelativeTime(last.created_at),
                    trigger: last.trigger,
                    created: last.created,
                    merged: last.merged,
                  })}
            </span>
            {last.error && (
              <span className="flex items-center gap-0.5 text-red-500 truncate" title={last.error}>
                <CircleAlert className="h-3 w-3 shrink-0" />
                <span className="truncate">{last.error}</span>
              </span>
            )}
          </>
        ) : (
          <span>{t('memory.health.never')}</span>
        )}
      </div>

      {totals.total > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {Object.entries(totals.byCategory).map(([cat, n]) => (
            <span
              key={cat}
              className={cn(
                'px-1.5 py-0.5 rounded text-[9px] font-medium capitalize',
                CATEGORY_COLORS[cat] ?? CATEGORY_COLORS.note,
              )}
            >
              {cat} {n}
            </span>
          ))}
          <span className="text-[9px] text-muted-foreground ml-1">
            {Object.entries(totals.bySource)
              .map(([src, n]) => `${t(`memory.source.${src}`, src)} ${n}`)
              .join(' · ')}
          </span>
          {!!totals.archived && totals.archived > 0 && (
            <button
              type="button"
              onClick={() => setRestoreOpen(true)}
              title={t('memory.restore.title')}
              className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-muted text-muted-foreground hover:bg-muted/60"
            >
              {t('memory.health.archived', { count: totals.archived })}
            </button>
          )}
        </div>
      )}

      {dryRun && (
        <details className="text-[10px] rounded border bg-background/60 px-2 py-1" open={!dryRun.ok}>
          <summary
            className={cn(
              'cursor-pointer select-none font-medium',
              dryRun.ok ? 'text-emerald-600 dark:text-emerald-300' : 'text-red-600 dark:text-red-300',
            )}
          >
            {dryRun.ok
              ? t('memory.health.testOk', { count: dryRun.candidates?.length ?? 0 })
              : t('memory.health.testFail', { step: dryRun.step ?? 'distill' })}
            {dryRun.binding && (
              <span className="text-muted-foreground font-normal">
                {' '}· {dryRun.binding.provider}/{dryRun.binding.model} ({dryRun.binding.resolvedFrom})
              </span>
            )}
          </summary>
          <div className="mt-1 space-y-1 text-muted-foreground">
            {dryRun.diag && (
              <div>
                {dryRun.diag.outcome}
                {dryRun.diag.httpStatus ? ` · HTTP ${dryRun.diag.httpStatus}` : ''}
                {` · ${dryRun.diag.rawChars} chars · ${Math.round(dryRun.diag.latencyMs)}ms`}
                {dryRun.diag.errorSnippet ? ` — ${dryRun.diag.errorSnippet}` : ''}
              </div>
            )}
            {dryRun.error && <div className="text-red-500 break-all">{dryRun.error}</div>}
            {!!dryRun.candidates?.length && (
              <ul className="list-disc pl-4">
                {dryRun.candidates.map((cand, i) => (
                  <li key={i}>[{cand.category}] {cand.title}</li>
                ))}
              </ul>
            )}
            {dryRun.rawResponse && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all bg-muted/40 rounded p-1">
                {dryRun.rawResponse}
              </pre>
            )}
          </div>
        </details>
      )}

      <RestoreArchivedDialog
        projectId={projectId}
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
        onRestored={refetch}
      />
    </div>
  );
}
