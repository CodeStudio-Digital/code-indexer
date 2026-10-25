import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBaseUrl } from '../../../lib/api-client.js';
import { apiPost } from '../../../hooks/useApi.js';

export interface SessionReference { kind: 'chat' | 'project'; id: string; label: string; detail: string }
export function sessionMention(input: string, caret: number) {
  const match = /(?:^|\s)([@$])([^\s@$#]*)$/u.exec(input.slice(0, caret));
  return match ? { trigger: match[1]!, query: match[2]!, start: caret - match[2]!.length - 1, end: caret } : null;
}
export function useSessionReferences(sessionId: string | null | undefined, input: string, caret: number) {
  const [picks, setPicks] = useState<SessionReference[]>([]);
  const [items, setItems] = useState<SessionReference[]>([]);
  const [index, setIndex] = useState(0), [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null), [dismissed, setDismissed] = useState('');
  const mention = sessionMention(input, caret);
  const token = `${input}:${caret}`;
  const open = Boolean(sessionId && mention && token !== dismissed);
  const projects = picks.filter(item => item.kind === 'project').map(item => item.id).join(',');
  const current = useRef({ sessionId, input }); current.current = { sessionId, input };
  const pending = useRef(false);
  useEffect(() => { setPicks([]); setItems([]); setError(null); }, [sessionId]);
  useEffect(() => {
    if (!open || !mention) return;
    const abort = new AbortController(); setLoading(true); setItems([]); setIndex(0); setError(null);
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ kind: mention.trigger === '$' ? 'projects' : 'chats', query: mention.query, project_ids: projects });
      fetch(`${apiBaseUrl()}/api/coder/sessions/${sessionId}/collaboration/suggestions?${query}`, { signal: abort.signal })
        .then(async response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
        .then(data => { if (!abort.signal.aborted) setItems(data.items); })
        .catch(reason => { if (!abort.signal.aborted) setError(String(reason)); })
        .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    }, 150);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [open, mention?.query, mention?.trigger, sessionId, projects]);
  const commit = useCallback(async () => {
    if (!picks.length) return true;
    if (!sessionId || pending.current) return false;
    pending.current = true;
    try {
      await apiPost(`/coder/sessions/${sessionId}/collaboration/references`, {
        chatIds: picks.filter(item => item.kind === 'chat').map(item => item.id),
        projectIds: picks.filter(item => item.kind === 'project').map(item => Number(item.id)),
      });
      if (current.current.sessionId !== sessionId || current.current.input !== input) return false;
      window.dispatchEvent(new CustomEvent('coder:collaboration-changed', { detail: { sessionId } }));
      return true;
    } catch (reason) { setError(String(reason)); return false; }
    finally { pending.current = false; }
  }, [picks, sessionId, input]);
  return { picks, items, mention, open, index, setIndex, loading, error, commit,
    choose: (item: SessionReference) => setPicks(rows => rows.some(row => row.kind === item.kind && row.id === item.id) ? rows : [...rows, item]),
    remove: (item: SessionReference) => setPicks(rows => rows.filter(row => row.kind !== item.kind || row.id !== item.id)),
    clear: () => setPicks([]), dismiss: () => setDismissed(token) };
}
