import { useEffect, useState } from 'react';
import { Network } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiPut, useApi } from '../../../hooks/useApi.js';

export function AgenticModeControl({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('chat');
  const { data, refetch, error } = useApi<{ enabled: boolean }>(`/coder/sessions/${sessionId}/collaboration/settings`);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    const changed = (event: Event) => { if ((event as CustomEvent).detail?.sessionId === sessionId) refetch(); };
    window.addEventListener('coder:collaboration-changed', changed);
    return () => window.removeEventListener('coder:collaboration-changed', changed);
  }, [sessionId, refetch]);
  const toggle = async () => {
    setBusy(true); setFailure(null);
    try { await apiPut(`/coder/sessions/${sessionId}/collaboration/settings`, { enabled: !data?.enabled }); refetch(); window.dispatchEvent(new CustomEvent('coder:collaboration-changed', { detail: { sessionId } })); }
    catch (reason) { setFailure(String(reason)); }
    finally { setBusy(false); }
  };
  return <span className="inline-flex items-center gap-1">
    <button type="button" aria-pressed={data?.enabled ?? false} disabled={busy || !data}
      onClick={() => void toggle()} title={t('network.modeHint')}
      className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs ${data?.enabled ? 'bg-violet-500/15 text-violet-500' : 'text-muted-foreground hover:bg-muted'}`}>
      <Network className="h-3.5 w-3.5" />{t('network.mode')}
    </button>
    <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => window.dispatchEvent(new CustomEvent('coder:open-collaboration', { detail: { sessionId } }))}>{t('network.configure')}</button>
    {(error || failure) && <span role="alert" className="text-xs text-destructive">{failure ?? error}</span>}
  </span>;
}
