import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiPost, apiPut, useApi } from '../../../hooks/useApi.js';
interface Peer { id: string; sessionId: string; label: string; state: string; parentId?: string }
interface Message { id: string; from: string; to: string; kind: string; body: string; status: string; references: string[] }
interface Data { self: string; stopped?: boolean; peers: Peer[]; messages: Message[]; candidates: Array<{ id: string; title: string }>;
  policy?: { effective: { reasoning: { effort?: string }; parallelism: { maxAgents: number } } } }
export function ChatCollaborationPanel({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('chat');
  const { data, error, refetch } = useApi<Data>('/coder/sessions/' + sessionId + '/collaboration');
  const [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState === 'visible') refetch(); }, 5000); return () => clearInterval(timer); }, [refetch]);
  const change = async (operation: () => Promise<unknown>) => {
    setBusy(true); setFailure(null);
    try { await operation(); setSelected(''); refetch(); } catch (error) { setFailure(String(error)); } finally { setBusy(false); }
  };
  const link = (target: string, enabled: boolean) => change(() => apiPut('/coder/sessions/' + sessionId + '/collaboration/links', { sessionId: target, enabled }));
  const name = (id: string) => id === data?.self ? t('collaboration.thisChat') : data?.peers.find(peer => peer.id === id)?.label ?? id;
  const linked = new Set(data?.peers.filter(peer => !peer.parentId).map(peer => peer.sessionId));
  return <div className="h-full space-y-3 overflow-y-auto p-3 text-xs" data-testid="chat-collaboration">
    <p className="text-muted-foreground">{t('collaboration.description')}</p>
    {(error || failure) && <p role="alert" className="text-destructive">{failure ?? error}</p>}
    {data?.policy && <p>{t('collaboration.policy', { effort: data.policy.effective.reasoning.effort ?? 'auto', count: data.policy.effective.parallelism.maxAgents })}</p>}
    <div className="flex gap-2">
      <select aria-label={t('collaboration.choose')} value={selected} onChange={event => setSelected(event.target.value)} className="min-w-0 flex-1 rounded border bg-background p-1.5">
        <option value="">{t('collaboration.choose')}</option>
        {data?.candidates.filter(candidate => !linked.has(candidate.id)).map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
      </select>
      <button className="rounded border px-2 disabled:opacity-40" disabled={!selected || busy} onClick={() => void link(selected, true)}>{t('collaboration.link')}</button>
    </div>
    {data?.peers.map(peer => <div key={peer.id} className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate" title={peer.id}>{peer.label}</span>
      <span className="text-muted-foreground">{t('collaboration.state.' + peer.state, peer.state)}</span>
      {!peer.parentId && <button className="rounded px-1 text-muted-foreground hover:text-foreground" disabled={busy} onClick={() => void link(peer.sessionId, false)}>{t('collaboration.unlink')}</button>}
    </div>)}
    <button className="rounded border px-2 py-1 disabled:opacity-40" disabled={busy} onClick={() => void change(() => apiPost('/coder/sessions/' + sessionId + '/collaboration/' + (data?.stopped ? 'resume' : 'stop'), {}))}>{t(data?.stopped ? 'collaboration.resume' : 'collaboration.stop')}</button>
    {!data?.messages.length && <p className="text-muted-foreground">{t('collaboration.empty')}</p>}
    {data?.messages.map(message => <details key={message.id} className="rounded border px-2 py-1.5">
      <summary className="cursor-pointer leading-5"><span>{name(message.from)} → {name(message.to)}</span><span className="ml-2 text-muted-foreground">{t('collaboration.kind.' + message.kind, message.kind)} · {t('collaboration.status.' + message.status, message.status)}</span></summary>
      <p className="mt-2 whitespace-pre-wrap break-words">{message.body}</p>
      {message.references.map(reference => <div key={reference} className="mt-1 break-all font-mono text-muted-foreground">{reference}</div>)}
    </details>)}
  </div>;
}
