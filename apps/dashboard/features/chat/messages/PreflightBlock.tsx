/**
 * Shown while the BLOCKING task-preflight analysis runs on the first message of
 * a fresh session — the model is picking the tool profile / MCP tools / skills
 * before the run starts. Replaces the bare spinner with a labelled indicator +
 * elapsed seconds so a ~10s wait doesn't read as frozen.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';

function secsSince(startedAt: number): number {
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

export function PreflightBlock({ startedAt }: { startedAt: number }) {
  const { t } = useTranslation('chat');
  const [elapsed, setElapsed] = useState(() => secsSince(startedAt));
  useEffect(() => {
    const id = setInterval(() => setElapsed(secsSince(startedAt)), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Sparkles className="h-3.5 w-3.5 shrink-0 animate-pulse text-amber-500" />
      <span className="font-medium">{t('messages.preflight')}</span>
      {elapsed > 0 && <span className="tabular-nums opacity-70">{`(${elapsed}s)`}</span>}
    </div>
  );
}
