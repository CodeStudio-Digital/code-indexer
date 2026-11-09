import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiPost, apiPut, useApi } from '../../../hooks/useApi.js';
import type { NetworkData } from './network-types.js';
import { SessionNetworkGraph } from './SessionNetworkGraph.js';
import { SessionNetworkSetup } from './SessionNetworkSetup.js';
import { SessionNetworkTriggers } from './SessionNetworkTriggers.js';
import { UltraFollowupsPanel } from './UltraFollowupsPanel.js';
import { isNetworkSnapshot } from './network-payload.js';
import { usePolling } from '../../../hooks/usePolling.js';
import { useSurfaceVisible } from '../../../lib/surface-visibility.js';

export function ChatCollaborationPanel({ sessionId }: { sessionId: string }) {
  const visible = useSurfaceVisible();
  const { t } = useTranslation('chat');
  const { data: payload, error, refetch } = useApi<NetworkData>(`/coder/sessions/${sessionId}/collaboration`);
  const data = isNetworkSnapshot(payload) ? payload : null;
  const invalid = payload != null && data === null;
  const [tab, setTab] = useState('graph');
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  usePolling(refetch, 5000, { immediate: false });
  useEffect(() => {
    if (!visible) return;
    const onChanged = (event: Event) => { if ((event as CustomEvent).detail?.sessionId === sessionId) refetch(); };
    window.addEventListener('coder:collaboration-changed', onChanged);
    return () => window.removeEventListener('coder:collaboration-changed', onChanged);
  }, [refetch, sessionId, visible]);
  const changed = () => { refetch(); window.dispatchEvent(new CustomEvent('coder:collaboration-changed', { detail: { sessionId } })); };
  const link = async (target: string, enabled: boolean) => {
    setBusy(true); setFailure(null);
    try { await apiPut(`/coder/sessions/${sessionId}/collaboration/links`, { sessionId: target, enabled }); setSelected(''); refetch(); }
    catch (error) { setFailure(String(error)); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true); setFailure(null);
    try { await apiPost(`/coder/sessions/${sessionId}/collaboration/${data?.stopped ? 'resume' : 'stop'}`, {}); refetch(); }
    catch (error) { setFailure(String(error)); }
    finally { setBusy(false); }
  };
  const name = (id: string) => id === data?.self ? t('collaboration.thisChat') : data?.peers.find(peer => peer.id === id)?.label ?? id;
  const linked = new Set(data?.peers.filter(peer => !peer.parentId).map(peer => peer.sessionId));
  return <div className="flex h-full min-h-0 flex-col text-xs" data-testid="chat-collaboration">
    <div role="tablist" aria-label={t('collaboration.title')} className="flex flex-wrap gap-1 border-b p-2">
      {['graph', 'setup', 'triggers', 'messages', 'followups'].map(value => <button key={value} role="tab" aria-selected={tab === value} className={`rounded px-2 py-1 ${tab === value ? 'bg-accent font-medium' : 'text-muted-foreground'}`} onClick={() => setTab(value)}>{t(`network.tab.${value}`)}</button>)}
    </div>
    {(error || failure || invalid) && <div role="alert" className="p-3 text-destructive">{failure ?? error ?? t('collaboration.invalidResponse')}
      <button className="ml-2 underline" onClick={refetch}>{t('messages.retry')}</button></div>}
    {!data && !error && !invalid && <p className="p-3">{t('drive.loading')}</p>}
    <div role="tabpanel" className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
    {tab === 'followups' && <UltraFollowupsPanel key={sessionId} sessionId={sessionId} />}
    {data && tab === 'setup' && <SessionNetworkSetup key={sessionId} sessionId={sessionId} data={data} changed={changed} />}
    {data && tab === 'triggers' && <SessionNetworkTriggers key={sessionId} sessionId={sessionId} data={data} changed={changed} />}
    {data && tab === 'graph' && <>
      <SessionNetworkGraph data={data} />
      <p className="text-muted-foreground">{t('network.referencesHint')}</p>
      <div className="flex gap-2">
        <select aria-label={t('collaboration.choose')} value={selected} onChange={event => setSelected(event.target.value)} className="min-w-0 flex-1 rounded border bg-background p-1.5">
          <option value="">{t('collaboration.choose')}</option>
          {data?.candidates.filter(candidate => !linked.has(candidate.id)).map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
        </select>
        <button className="rounded border px-2 disabled:opacity-40" disabled={!selected || busy} onClick={() => void link(selected, true)}>{t('collaboration.link')}</button>
      </div>
      {data?.peers.map(peer => <div key={peer.id} className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate" title={peer.id}>{peer.label}</span>
        <span className="text-muted-foreground">{t(`collaboration.state.${peer.state}`, peer.state)}</span>
        {!peer.parentId && <button className="rounded px-1 text-muted-foreground hover:text-foreground" disabled={busy} onClick={() => void link(peer.sessionId, false)}>{t('collaboration.unlink')}</button>}
      </div>)}
      <button className="rounded border px-2 py-1 disabled:opacity-40" disabled={busy} onClick={() => void stop()}>{t(data.stopped ? 'collaboration.resume' : 'collaboration.stop')}</button>
    </>}
    {tab === 'messages' && <>
      {!data?.messages.length && <p className="text-muted-foreground">{t('collaboration.empty')}</p>}
      {data?.messages.map(message => <details key={message.id} className="rounded border px-2 py-1.5">
        <summary className="cursor-pointer leading-5">
          <span>{name(message.from)} → {name(message.to)}</span>
          <span className="ml-2 text-muted-foreground">{t(`collaboration.kind.${message.kind}`, message.kind)} · {t(`collaboration.status.${message.status}`, message.status)}</span>
        </summary>
        <p className="mt-2 whitespace-pre-wrap break-words">{message.body}</p>
        {message.references.map(reference => <div key={reference} className="mt-1 break-all font-mono text-muted-foreground">{reference}</div>)}
      </details>)}
    </>}
    </div>
  </div>;
}
