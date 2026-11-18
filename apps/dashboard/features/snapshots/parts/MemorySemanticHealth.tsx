import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, RefreshCw } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { useConfirm } from '../../../components/ui/dialog-provider.js';
import { apiPost, useApi } from '../../../hooks/useApi.js';
import { usePolling } from '../../../hooks/usePolling.js';

interface Coverage {
  live: number; indexed: number; failed: number; missing: number; pending: number; queuedMutations: number;
  repairing: boolean; blocked: boolean; retryAt: number | null; errorCode: string | null;
}
interface MemorySemantic { enabled: boolean; remote: boolean; project: Coverage; user: Coverage; embeddingModel: string | null; rerankerModel: string | null }

export function MemorySemanticHealth({ projectId, revision = 0 }: { projectId: number; revision?: number }) {
  const { t, i18n } = useTranslation('projects');
  const confirm = useConfirm();
  const { data, error, refetch, update } = useApi<MemorySemantic>(`/projects/${projectId}/agent-memory/semantic`);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  usePolling(refetch, 5000, { enabled: !!data?.project.repairing || !!data?.user.repairing, immediate: false });
  useEffect(() => { if (revision) refetch(); }, [revision, refetch]);
  const repair = async (scope: 'project' | 'user') => {
    if (!data) return;
    if (data.remote && !await confirm({ title: t('memory.semantic.confirmTitle'),
      description: t('memory.semantic.confirmRemote'), confirmLabel: t('memory.semantic.repair'), variant: 'warning' })) return;
    setBusy(true); setActionError(null);
    try {
      await apiPost(`/projects/${projectId}/agent-memory/semantic/repair`, { scope, confirmRemote: data.remote });
      update(current => ({ ...current, [scope]: { ...current[scope], repairing: true } })); refetch();
    }
    catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <section className="rounded-lg border p-4 space-y-3 text-xs">
    <div className="flex items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-sm font-medium"><Database className="h-4 w-4 text-primary" />{t('memory.semantic.title')}</h3>
      <Button variant="ghost" size="sm" aria-label={t('memory.semantic.refresh')} onClick={refetch}><RefreshCw className="h-3.5 w-3.5" /></Button></div>
    <p className="text-muted-foreground leading-relaxed">{t('memory.semantic.hint')}</p>
    {(error || actionError) && <p role="alert" className="text-destructive">{error || actionError}</p>}
    {data && !data.enabled && <p className="text-muted-foreground">{t('memory.semantic.disabled')}</p>}
    <div className="grid gap-3 sm:grid-cols-2">{data && (['project', 'user'] as const).map(scope => {
      const coverage = data[scope];
      const percent = coverage.live ? Math.min(100, Math.round(100 * coverage.indexed / coverage.live)) : 100;
      const complete = coverage.indexed === coverage.live && !coverage.failed && !coverage.missing && !coverage.pending;
      return <div key={scope} className="min-w-0 rounded-md border bg-muted/20 p-3 space-y-2" data-testid={`memory-coverage-${scope}`}>
        <div className="flex justify-between gap-2"><strong>{t(`memory.semantic.${scope}`)}</strong><span className="tabular-nums text-muted-foreground">{coverage.indexed} / {coverage.live} · {percent}%</span></div>
        <div role="progressbar" aria-label={t(`memory.semantic.${scope}`)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 rounded-full bg-muted overflow-hidden"><div className={`h-full ${complete ? 'bg-emerald-500' : 'bg-primary'}`} style={{ width: `${percent}%` }} /></div>
        <p className="text-muted-foreground">{t('memory.semantic.remaining', { missing: coverage.missing, failed: coverage.failed, pending: coverage.pending })}</p>
        {coverage.errorCode && <p role="status" className={coverage.errorCode === 'rate_limit' ? 'text-amber-500' : 'text-destructive'}>{t(`memory.semantic.error.${coverage.errorCode}`, t('memory.semantic.error.embedding_failed'))}</p>}
        {!complete && coverage.retryAt && !coverage.blocked && <p className="text-muted-foreground">{t('memory.semantic.retryAt', { time: new Date(coverage.retryAt).toLocaleTimeString(i18n.resolvedLanguage) })}</p>}
        {coverage.blocked && <p className="text-muted-foreground">{t('memory.semantic.blocked')}</p>}
        <Button size="sm" variant="outline" disabled={!data.enabled || busy || coverage.repairing || complete} onClick={() => repair(scope)}>{t(coverage.repairing ? 'memory.semantic.repairing' : complete ? 'memory.semantic.complete' : 'memory.semantic.repair')}</Button>
      </div>;
    })}</div>
    {data?.enabled && <details className="text-muted-foreground"><summary className="cursor-pointer">{t('memory.semantic.models')}</summary>
      <div className="pt-2 space-y-1 break-all"><p>Embedding: {data.embeddingModel}</p><p>Reranker: {data.rerankerModel ?? '—'}</p><p className="break-normal">{t('memory.semantic.configure')}</p></div></details>}
  </section>;
}
