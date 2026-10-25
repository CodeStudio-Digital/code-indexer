import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiDelete, apiPost } from '../../../hooks/useApi.js';
import type { NetworkData } from './network-types.js';

export function SessionNetworkTriggers({ sessionId, data, changed }: { sessionId: string; data: NetworkData; changed: () => void }) {
  const { t } = useTranslation('chat');
  const [source, setSource] = useState(''), [target, setTarget] = useState(sessionId), [prompt, setPrompt] = useState('');
  const [event, setEvent] = useState('completed'), [includeFinal, setIncludeFinal] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const attempt = useRef({ payload: '', requestId: '' });
  const name = (id: string) => data.chats.find(chat => chat.id === id)?.title ?? id;
  const create = async () => {
    setBusy(true); setError(null);
    const input = { sourceSessionId: source, targetSessionId: target, event, prompt, includeFinal };
    const payload = JSON.stringify(input);
    if (attempt.current.payload !== payload) attempt.current = { payload, requestId: crypto.randomUUID() };
    try { await apiPost(`/coder/sessions/${sessionId}/collaboration/triggers`, { requestId: attempt.current.requestId, ...input }); attempt.current.payload = ''; setPrompt(''); changed(); }
    catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  return <div className="space-y-3">
    <p className="text-muted-foreground">{t('network.triggerHint')}</p>
    {data.triggers.map(trigger => <div key={trigger.id} className="space-y-1 rounded border p-2"><p>{name(trigger.sourceSessionId)} → {name(trigger.targetSessionId)}</p>
      <p className="text-muted-foreground">{t(`network.trigger.${trigger.status}`)} · {t(`network.event.${trigger.event}`)}</p><p className="whitespace-pre-wrap">{trigger.prompt}</p>
      {trigger.status === 'waiting' && trigger.ownerSessionId === sessionId && <button type="button" className="text-destructive" onClick={() => { void apiDelete(`/coder/sessions/${sessionId}/collaboration/triggers/${trigger.id}`).then(changed).catch(reason => setError(String(reason))); }}>{t('network.cancel')}</button>}
    </div>)}
    <fieldset disabled={busy || !data.config.enabled} className="space-y-2 border-t pt-3">
      <label className="block">{t('network.whenChat')}<select aria-label={t('network.whenChat')} className="mt-1 w-full rounded border bg-background p-1.5" value={source} onChange={e => setSource(e.target.value)}><option value="">{t('collaboration.choose')}</option>{data.chats.map(chat => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</select></label>
      <select aria-label={t('network.eventLabel')} className="w-full rounded border bg-background p-1.5" value={event} onChange={e => setEvent(e.target.value)}>{['completed', 'failed', 'finished'].map(value => <option key={value} value={value}>{t(`network.event.${value}`)}</option>)}</select>
      <label className="block">{t('network.wakeChat')}<select aria-label={t('network.wakeChat')} className="mt-1 w-full rounded border bg-background p-1.5" value={target} onChange={e => setTarget(e.target.value)}>{data.chats.map(chat => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</select></label>
      <textarea aria-label={t('network.triggerPrompt')} placeholder={t('network.triggerPrompt')} className="min-h-20 w-full rounded border bg-background p-2" value={prompt} onChange={e => setPrompt(e.target.value)} />
      <label className="flex gap-2"><input type="checkbox" checked={includeFinal} onChange={e => setIncludeFinal(e.target.checked)} />{t('network.includeFinal')}</label>
      <button type="button" disabled={!source || source === target || !prompt.trim()} className="rounded border px-2 py-1 disabled:opacity-40" onClick={() => void create()}>{t('network.addTrigger')}</button>
    </fieldset>{error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}
