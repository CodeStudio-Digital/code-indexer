import { useCallback, useEffect, useState } from 'react';
import { apiBaseUrl } from '../../../lib/api-client.js';
import { skillMention, type SkillMention, type SkillSuggestion } from './skill-mention.js';

export function useSkillPicker(input: string, sessionId?: string | null) {
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [commands, setCommands] = useState<SkillSuggestion[]>([]);
  const [picks, setPicks] = useState<SkillSuggestion[]>([]);
  const [loadedKey, setLoadedKey] = useState('');
  const [error, setError] = useState(false);
  const [index, setIndex] = useState(0);
  const mention: SkillMention | null = skillMention(input, caret);
  const key = mention ? `${sessionId ?? ''}:${mention.trigger}:${mention.query}` : '';
  const open = Boolean(key && dismissed !== `${input}:${caret}`);
  const resolveSlash = useCallback(async (command: string) => {
    const cached = [...picks, ...commands].find(item => item.command?.toLowerCase() === command.toLowerCase());
    if (cached) return cached;
    const params = new URLSearchParams({ query: command, trigger: '/' });
    if (sessionId) params.set('session_id', sessionId);
    const response = await fetch(`${apiBaseUrl()}/api/coder/skills/suggestions?${params}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json() as { commands: SkillSuggestion[] };
    return data.commands.find(item => item.command?.toLowerCase() === command.toLowerCase()) ?? null;
  }, [commands, picks, sessionId]);
  useEffect(() => { setPicks([]); setCommands([]); setLoadedKey(''); }, [sessionId]);
  useEffect(() => {
    setIndex(0);
    if (!open || !mention) return;
    const controller = new AbortController();
    setError(false);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ query: mention.query, trigger: mention.trigger });
      if (sessionId) params.set('session_id', sessionId);
      fetch(`${apiBaseUrl()}/api/coder/skills/suggestions?${params}`, { signal: controller.signal })
        .then(async res => { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
        .then(data => { if (!controller.signal.aborted) { setCommands(data.commands); setLoadedKey(key); } })
        .catch(() => { if (!controller.signal.aborted) { setError(true); setLoadedKey(key); setCommands([]); } });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, open, sessionId]);
  return { mention, commands, picks, setPicks, caret, setCaret, index, setIndex, open, resolveSlash,
    loading: open && loadedKey !== key, error,
    visible: loadedKey === key ? commands : [],
    dismiss: () => setDismissed(`${input}:${caret}`),
    clear: () => setPicks([]),
  };
}
