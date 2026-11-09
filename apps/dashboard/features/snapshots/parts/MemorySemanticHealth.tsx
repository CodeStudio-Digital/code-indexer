import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button.js';
import { useConfirm } from '../../../components/ui/dialog-provider.js';
import { apiPost, useApi } from '../../../hooks/useApi.js';
import { usePolling } from '../../../hooks/usePolling.js';

interface Coverage {
  live: number; indexed: number; failed: number; missing: number; pending: number; queuedMutations: number;
  repairing: boolean; blocked: boolean; retryAt: number | null; errorCode: string | null;
}
interface MemorySemantic { enabled: boolean; remote: boolean; project: Coverage; user: Coverage }

export function MemorySemanticHealth({ projectId }: { projectId: number }) {
  const { t } = useTranslation('projects');
  const confirm = useConfirm();
  const { data, error, refetch } = useApi<MemorySemantic>(`/projects/${projectId}/agent-memory/semantic`);
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  usePolling(refetch, 5000, { enabled: watching, immediate: false });
  useEffect(() => {
    if (data && !data.project.repairing && !data.user.repairing) setWatching(false);
  }, [data]);
  const repair = async (scope: 'project' | 'user') => {
    if (!data) return;
    if (data.remote && !await confirm({ title: t('memory.semantic.confirmTitle'),
      description: t('memory.semantic.confirmRemote'), confirmLabel: t('memory.semantic.repair'), variant: 'warning' })) return;
    setBusy(true); setActionError(null);
    try { await apiPost(`/projects/${projectId}/agent-memory/semantic/repair`, { scope, confirmRemote: data.remote }); setWatching(true); refetch(); }
    catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <details className="border-b px-3 py-2 text-xs">
    <summary className="cursor-pointer font-medium">{t('memory.semantic.title')}</summary>
    <p className="text-[11px] text-muted-foreground py-1">{t('memory.semantic.hint')}</p>
    {(error || actionError) && <p role="alert" className="text-destructive">{error || actionError}</p>}
    <Button variant="ghost" size="sm" onClick={refetch}>{t('memory.health.refresh')}</Button>
    {data && !data.enabled && <p className="text-muted-foreground">{t('memory.semantic.disabled')}</p>}
    {data && (['project', 'user'] as const).map(scope => <div key={scope} className="flex flex-wrap items-center gap-2 py-1">
      <strong>{t(`memory.semantic.${scope}`)}</strong>
      <span>{t('memory.semantic.coverage', data[scope] as unknown as Record<string, unknown>)}</span>
      <Button size="sm" variant="outline" disabled={!data.enabled || busy || data[scope].repairing} onClick={() => repair(scope)}>{t(data[scope].repairing ? 'memory.semantic.repairing' : 'memory.semantic.repair')}</Button>
      {data[scope].errorCode && <span className="text-destructive">{t(`memory.semantic.error.${data[scope].errorCode}`, data[scope].errorCode!)}</span>}
    </div>)}
  </details>;
}
