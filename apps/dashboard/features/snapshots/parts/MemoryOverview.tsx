import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, RefreshCw, Sparkles } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Switch } from '../../../components/ui/switch.js';
import { apiPatch, apiPost, useApi } from '../../../hooks/useApi.js';
import { usePolling } from '../../../hooks/usePolling.js';

interface Overview {
  enabled: boolean;
  totals: { total: number; archived: number };
  usage: { liveProject: number; liveUser: number; recallHits: number; recallEmpty: number; events: Record<string, number> };
  evolution: { enabled: boolean; pending: number; running: boolean; queued?: boolean; nextAt: number | null; lastAt: number | null;
    errorCode: string | null; lastResult: { reviewed: number; merged: number; refined: number; retired: number; rejected: number } | null } | null;
}

export function MemoryOverview({ projectId, revision, onChanged }: { projectId: number; revision: number; onChanged: () => void }) {
  const { t, i18n } = useTranslation('projects');
  const { data, error, refetch } = useApi<Overview>(`/projects/${projectId}/agent-memory/overview`);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  usePolling(refetch, 30_000, { enabled: !!data?.enabled, immediate: false });
  useEffect(() => { if (revision) refetch(); }, [revision, refetch]);
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true); setActionError(null);
    try { await run(); onChanged(); } catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const evolution = data?.evolution;
  const state = !evolution?.enabled ? 'disabled' : evolution.running ? 'running' : evolution.queued ? 'queued' : evolution.errorCode ? 'paused' : evolution.pending ? 'pending' : 'current';
  return <section className="space-y-4">
    <header className="flex flex-wrap items-center gap-3">
      <div className="rounded-lg bg-primary/10 p-2.5"><Brain className="h-5 w-5 text-primary" /></div>
      <div className="min-w-48 flex-1"><h2 className="text-base font-semibold">{t('memory.overview.title')}</h2>
        <p className="text-xs text-muted-foreground">{data ? t('memory.agent.counts', { project: data.usage.liveProject, user: data.usage.liveUser }) : t('memory.curation.loading')}</p></div>
      <Button variant="ghost" size="sm" aria-label={t('memory.health.refresh')} onClick={onChanged}><RefreshCw className="h-4 w-4" /></Button>
      {data && <label className="flex items-center gap-2 text-xs text-muted-foreground">{t('memory.toggle.label')}
        <Switch aria-label={t('memory.toggle.label')} disabled={busy} checked={data.enabled}
          onCheckedChange={enabled => act(() => apiPatch(`/projects/${projectId}`, { memory_enabled: enabled }))} /></label>}
    </header>
    {(error || actionError) && <p role="alert" className="text-xs text-destructive">{error || actionError}</p>}
    {data && <div className="grid gap-3 lg:grid-cols-2">
      <div className="rounded-lg border bg-card/50 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-sm font-medium"><Sparkles className="h-4 w-4 text-primary" />{t('memory.evolution.title')}</h3>
          <span className={`rounded px-2 py-0.5 text-xs ${state === 'paused' ? 'bg-amber-500/10 text-amber-500' : 'bg-muted text-muted-foreground'}`}>{t(`memory.evolution.${state}`, { count: evolution?.pending ?? 0 })}</span></div>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('memory.evolution.description')}</p>
        {evolution?.lastResult && <p className="text-xs">{t('memory.evolution.result', { ...evolution.lastResult })}</p>}
        {evolution?.lastAt && <p className="text-xs text-muted-foreground">{t('memory.evolution.last', { time: new Date(evolution.lastAt).toLocaleString(i18n.resolvedLanguage) })}</p>}
        {evolution?.errorCode && <p role="status" className="text-xs text-amber-500">{t(`memory.evolution.error.${evolution.errorCode}`, t('memory.evolution.error.provider_unavailable'))}
          {evolution.nextAt && ` ${t('memory.semantic.retryAt', { time: new Date(evolution.nextAt).toLocaleTimeString(i18n.resolvedLanguage) })}`}</p>}
        <div className="flex flex-wrap items-center gap-3"><Button size="sm" variant="outline" disabled={busy || !evolution?.enabled || evolution.running || evolution.queued || !evolution.pending}
          onClick={() => act(() => apiPost(`/projects/${projectId}/agent-memory/evolution`, {}))}>{t('memory.evolution.review')}</Button>
          <span className="text-xs text-muted-foreground">{t('memory.evolution.protected')}</span></div>
      </div>
      <div className="rounded-lg border bg-card/50 p-4 space-y-3">
        <h3 className="text-sm font-medium">{t('memory.overview.usage')}</h3>
        <div className="grid grid-cols-3 gap-2">{[
          ['recalled', data.usage.recallHits], ['injected', data.usage.events.injected ?? 0], ['read', data.usage.events.explicit_read ?? 0],
        ].map(([label, count]) => <div key={label} className="rounded-md bg-muted/50 p-2.5"><div className="text-lg font-semibold tabular-nums">{count}</div><div className="text-xs text-muted-foreground">{t(`memory.overview.${label}`)}</div></div>)}</div>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('memory.agent.evidenceHint')}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('memory.overview.history', { count: data.totals.archived })}</p>
      </div>
    </div>}
  </section>;
}
