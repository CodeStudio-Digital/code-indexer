import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, RefreshCw, Send, Square, Trash2, X } from 'lucide-react';
import type { SideChatTurn, SideChatView } from '@mcp/shared/side-chat.js';
import { apiBaseUrl } from '../../../lib/api-client-transport.js';
import { Button } from '../../../components/ui/button.js';
import { Markdown } from '../messages/Markdown.js';
import type { OpenSideChat } from './side-chat-command.js';

async function request<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(apiBaseUrl() + '/api/coder/sessions/' + path, {
    method, signal, cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error((await response.text()).slice(0, 500) || 'HTTP ' + response.status);
  return response.json() as Promise<T>;
}

export function SideChatPanel({ sessionId, launch, onConsumed }: {
  sessionId: string; launch?: OpenSideChat; onConsumed?: (key: string) => void;
}) {
  const { t } = useTranslation('chat');
  const base = encodeURIComponent(sessionId) + '/side';
  const key = 'codestudio:side-draft:' + sessionId;
  const [draft, setDraft] = useState(() => localStorage.getItem(key) ?? '');
  const [chat, setChat] = useState<SideChatView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const retryTurn = useRef<{ id: string; question: string } | null>(null);
  const alive = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const running = chat?.turns.find(turn => turn.status === 'running')?.id;
  const action = launch?.parentId === sessionId ? launch : undefined;
  const consumed = useRef<string | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (draft) localStorage.setItem(key, draft); else localStorage.removeItem(key); }, [draft, key]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setError('');
      let current = await request<SideChatView>(base + '/open', 'POST', {}, controller.signal);
      if (!controller.signal.aborted) setChat(current);
      if (action && consumed.current !== action.key) {
        if (action.selection) current = await request(base + '/selection', 'POST', { selection: action.selection }, controller.signal);
        if (action.question) current = await request(base + '/turns', 'POST', { id: action.key, question: action.question }, controller.signal);
        if (!controller.signal.aborted) { consumed.current = action.key; onConsumed?.(action.key); }
      }
      if (!controller.signal.aborted) setChat(current);
    };
    void load().catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)); });
    input.current?.focus();
    return () => controller.abort();
  }, [base, action, onConsumed, retry]);

  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    const { signal } = controller;
    const watch = async () => {
      let answer = '';
      let failures = 0;
      while (!signal.aborted) {
        try {
          const turn = await request<SideChatTurn & { offset: number }>(base + '/turns/' + running + '?offset=' + answer.length, 'GET', undefined, signal);
          if (signal.aborted) return;
          failures = 0;
          setError('');
          answer = answer.slice(0, turn.offset) + turn.answer;
          const updated = { ...turn, answer };
          setChat(value => value && ({ ...value, turns: value.turns.map(row => row.id === running ? updated : row) }));
          if (turn.status !== 'running') return;
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (e) {
          if (signal.aborted) return;
          setError(e instanceof Error ? e.message : String(e));
          if (++failures >= 4) return;
          await new Promise(resolve => setTimeout(resolve, 400 * failures));
        }
      }
    };
    void watch();
    return () => controller.abort();
  }, [base, running, retry]);

  useEffect(() => {
    if (follow.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [chat]);

  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await operation(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (alive.current) setBusy(false); }
  };
  const send = () => {
    const question = draft.trim();
    if (!chat || !question || running || busy) return;
    const turn = retryTurn.current?.question === question ? retryTurn.current : { id: crypto.randomUUID(), question };
    retryTurn.current = turn;
    void perform(async () => {
      const result = await request<SideChatView>(base + '/turns', 'POST', turn);
      if (!alive.current) return;
      retryTurn.current = null; follow.current = true; setChat(result);
      setDraft(value => value.trim() === question ? '' : value);
    });
  };
  return <section aria-label={t('side.title')} className="flex h-full min-h-0 flex-col text-sm">
    {chat && <div className="flex flex-wrap items-center gap-1.5 border-b border-border p-2 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 break-words">{chat.target.provider} · {chat.target.model}{chat.target.effort && ' · ' + chat.target.effort}<br/>
        {t('side.context', { seq: chat.context.throughSeq })}{chat.context.truncated && ' · ' + t('side.excerpt')}</span>
      <Button size="icon" variant="ghost" aria-label={t('side.refresh')} title={t('side.refresh')} disabled={busy}
        onClick={() => void perform(async () => setChat(await request(base + '/context', 'POST', {})))}><RefreshCw size={15}/></Button>
      <Button size="icon" variant="ghost" aria-label={t('side.clear')} title={t('side.clear')} disabled={busy || !!running}
        onClick={() => setConfirmClear(true)}><Trash2 size={15}/></Button>
    </div>}
    {confirmClear && <div className="flex items-center gap-2 p-2 text-xs">{t('side.confirmClear')}
      <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>{t('side.keep')}</Button>
      <Button size="sm" onClick={() => void perform(async () => {
        await request(base, 'DELETE'); setConfirmClear(false); setDraft(''); setChat(null); setRetry(n => n + 1);
      })}>{t('side.clear')}</Button></div>}
    <div ref={log} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3" onScroll={e => {
      const box = e.currentTarget; follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    }}>
      {chat?.turns.map(turn => <article key={turn.id} data-side-turn={turn.id} data-status={turn.status} className="space-y-2">
        <div className="rounded-md bg-muted px-3 py-2">
          {turn.selection && <blockquote className="mb-1 border-l-2 pl-2 text-xs text-muted-foreground">{turn.selection.text}</blockquote>}
          <p className="whitespace-pre-wrap break-words">{turn.question}</p>
        </div>
        {turn.answer && <Markdown text={turn.answer}/>}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('side.context', { seq: turn.context.throughSeq })}{turn.status !== 'completed' && ' · ' + t('side.' + turn.status)}</span>
          {turn.answer && <Button size="icon" variant="ghost" title={t('side.copy')} aria-label={t('side.copy')}
            onClick={() => void perform(() => navigator.clipboard.writeText(turn.answer))}><Copy size={14}/></Button>}
        </div>
        {turn.error && <p role="alert" className="text-xs text-destructive">{turn.error}</p>}
      </article>)}
    </div>
    {error && <div role="alert" className="p-2 text-xs text-destructive">{error} <button onClick={() => setRetry(n => n + 1)}>{t('side.retry')}</button></div>}
    <div className="space-y-2 border-t border-border p-2">
      {chat?.selection && <div className="flex items-start gap-1 border-l-2 pl-2 text-xs"><span className="line-clamp-3 flex-1">{chat.selection.seq === null && t('side.partial') + ' · '}{chat.selection.text}</span>
        <button aria-label={t('side.removeQuote')} onClick={() => void perform(async () => setChat(await request(base + '/selection', 'POST', { selection: null })))}><X size={14}/></button></div>}
      <textarea ref={input} aria-label={t('side.ask')} placeholder={t('side.ask')} rows={3} value={draft} maxLength={12000}
        className="w-full resize-y rounded-md border border-border bg-background p-2 text-sm" onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}/>
      <div className="flex justify-end">{running
        ? <Button size="sm" variant="outline" onClick={() => void perform(async () => { await request(base + '/turns/' + running + '/cancel', 'POST', {}); })}><Square size={14}/>{t('side.cancel')}</Button>
        : <Button size="sm" disabled={!chat || !draft.trim() || busy} onClick={send}><Send size={14}/>{t('side.send')}</Button>}</div>
    </div>
  </section>;
}
