/**
 * Shown while the BLOCKING task-preflight analysis runs on the first message of
 * a fresh session — the model is picking the tool profile / skills / memories
 * before the run starts. Replaces the bare spinner with a labelled indicator +
 * elapsed seconds so a ~10s wait doesn't read as frozen.
 */
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { useNow } from '../../../lib/perf/shared-clock.js';

export function PreflightBlock({ startedAt }: { startedAt: number }) {
  const { t } = useTranslation('chat');
  // Elapsed comes off the app-wide 1 Hz clock — the preflight indicator no
  // longer owns a timer of its own.
  const elapsed = Math.max(0, Math.floor((useNow() - startedAt) / 1000));
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Sparkles className="h-3.5 w-3.5 shrink-0 animate-pulse text-amber-500" />
      <span className="font-medium">{t('messages.preflight')}</span>
      {elapsed > 0 && <span className="tabular-nums opacity-70">{`(${elapsed}s)`}</span>}
    </div>
  );
}
