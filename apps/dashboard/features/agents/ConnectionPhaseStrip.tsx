/**
 * Thin top strip that surfaces SSE connection phase transitions
 * (`replaying`, `disconnected`) to the user. Hidden during steady
 * states (`live`, `idle`).
 *
 * Intentionally minimal: a single colored bar with one line of text
 * sits above the chat content. Auto-hides after 1.5s of `live` so a
 * brief flicker during reconnect doesn't leave a stale label.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, WifiOff } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface ConnectionPhaseStripProps {
  phase: 'connecting' | 'replaying' | 'live' | 'disconnected' | 'idle';
}

const VISIBLE_PHASES = new Set(['replaying', 'disconnected', 'connecting']);

export function ConnectionPhaseStrip({ phase }: ConnectionPhaseStripProps) {
  const { t } = useTranslation('agents');
  // Debounce phase transitions by 250ms so a fast reconnect doesn't
  // produce a visible flash. We keep showing the strip briefly after
  // `live` to give the user feedback that catching-up finished.
  const [visiblePhase, setVisiblePhase] = useState<ConnectionPhaseStripProps['phase']>(phase);

  useEffect(() => {
    if (VISIBLE_PHASES.has(phase)) {
      const handle = setTimeout(() => setVisiblePhase(phase), 250);
      return () => clearTimeout(handle);
    }
    // Going to live/idle — hide after a short delay.
    const handle = setTimeout(() => setVisiblePhase('idle'), 1500);
    return () => clearTimeout(handle);
  }, [phase]);

  if (!VISIBLE_PHASES.has(visiblePhase)) return null;

  const label =
    visiblePhase === 'disconnected'
      ? t('connection.disconnected', 'Connection lost — retrying…')
      : visiblePhase === 'replaying'
        ? t('connection.replaying', 'Reconnecting — replaying events…')
        : t('connection.connecting', 'Connecting…');

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'px-3 py-1 text-[11px] flex items-center gap-2 border-b',
        visiblePhase === 'disconnected'
          ? 'bg-destructive/10 text-destructive border-destructive/20'
          : 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20',
      )}
    >
      {visiblePhase === 'disconnected' ? (
        <WifiOff className="h-3 w-3" />
      ) : (
        <Loader2 className="h-3 w-3 animate-spin" />
      )}
      <span>{label}</span>
    </div>
  );
}
