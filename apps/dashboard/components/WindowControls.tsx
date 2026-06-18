import { useTranslation } from 'react-i18next';
import { Minus, Square, X } from 'lucide-react';
import { useWindowChrome } from '../hooks/useWindowChrome.js';
import { cn } from '../lib/utils.js';

/**
 * Custom minimize / maximize-restore / close buttons for the frameless
 * window (VS Code style). Rendered only on win32/linux inside Electron —
 * macOS keeps its native traffic-lights, and the browser build has no
 * window to control, so both cases return `null`.
 */

/** Two overlapping squares — the "restore (un-maximize)" glyph. */
function RestoreIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} className={className}>
      <rect x="3.5" y="5.5" width="7" height="7" rx="0.5" />
      <path d="M5.5 5.5V4a.5.5 0 0 1 .5-.5h6a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5h-1.5" />
    </svg>
  );
}

const BTN = 'no-drag inline-flex h-9 w-11 items-center justify-center text-muted-foreground transition-colors';

export function WindowControls() {
  const { t } = useTranslation();
  const { platform, isElectron, isMaximized, minimize, toggleMaximize, close } = useWindowChrome();

  if (!isElectron || platform === 'darwin') return null;

  return (
    <div className="flex items-stretch self-stretch -mr-2">
      <button
        type="button"
        onClick={minimize}
        aria-label={t('windowControls.minimize')}
        className={cn(BTN, 'hover:bg-muted hover:text-foreground')}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={toggleMaximize}
        aria-label={t(isMaximized ? 'windowControls.restore' : 'windowControls.maximize')}
        className={cn(BTN, 'hover:bg-muted hover:text-foreground')}
      >
        {isMaximized ? <RestoreIcon className="h-3.5 w-3.5" /> : <Square className="h-3 w-3" />}
      </button>
      <button
        type="button"
        onClick={close}
        aria-label={t('windowControls.close')}
        className={cn(BTN, 'hover:bg-destructive hover:text-destructive-foreground')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
