import { useTranslation } from 'react-i18next';
import { PanelLeft, PanelLeftClose, StopCircle, Users } from 'lucide-react';
import { Badge } from '../../../components/ui/badge.js';
import { Button } from '../../../components/ui/button.js';
import { cn } from '../../../lib/utils.js';
import { SessionActionsMenu } from './SessionActionsMenu.js';
import type { useCompanyStream } from '../../../hooks/useCompanyStream.js';

interface SessionHeaderProps {
  sessionName: string;
  sessionStatus: string;
  /** Backend-reported status; falls back to `sessionStatus` when unloaded. */
  reportedStatus?: string;
  stream: ReturnType<typeof useCompanyStream>;
  /**
   * Outer-app toggle: shows/hides the sessions-list sidebar owned by
   * `AgentsTab`. When omitted (e.g. on routes that don't sit inside
   * AgentsTab) the button is hidden.
   */
  sessionsListOpen?: boolean;
  onToggleSessionsList?: () => void;
  /**
   * P15c — ISO timestamp set by the boot-time recovery sweep when the
   * server restart caught this session in `running` status. Renders a
   * "Recovered" pill so the user understands why the session is paused.
   */
  recoveredAt?: string | null;
  recoveredReason?: string | null;
  onResetClick: () => void;
  /**
   * Phase H — when set, the overflow menu shows a "Reestabelecer Master"
   * item that spawns the master-recovery agent. Provided by the parent
   * only when this is a master view (companyContext.isMaster === true).
   */
  onReestablishMasterClick?: () => void | Promise<void>;
}

/**
 * Top bar of the company-session view: session name + live status badge,
 * a compact projects chip, QA badge, and the primary Stop action — with
 * reconnect / reestablish / reset tucked into an overflow menu. Slimmed to
 * a single row to match the lean ProjectView chrome; the terminal toggle
 * moved to the left rail footer (`LeftTabRail`).
 */
export function SessionHeader({
  sessionName,
  sessionStatus,
  reportedStatus,
  stream,
  sessionsListOpen,
  onToggleSessionsList,
  recoveredAt,
  recoveredReason,
  onResetClick,
  onReestablishMasterClick,
}: SessionHeaderProps) {
  const { t } = useTranslation('agents');

  // Reconnect surfaces only when the session is running but the live SSE
  // stream dropped — moved into the overflow menu to keep the bar lean.
  const canReconnect = !stream.connected && sessionStatus === 'running' && stream.started;

  return (
    <header className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-2">
      {onToggleSessionsList && (
        <button
          type="button"
          className={cn(
            'grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors',
            sessionsListOpen
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
          onClick={onToggleSessionsList}
          title={sessionsListOpen ? t('fronts.closeList', 'Close sessions list') : t('fronts.openList', 'Open sessions list')}
        >
          {sessionsListOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
        </button>
      )}
      <Users className="h-4 w-4 text-muted-foreground shrink-0" />
      <h2 className="min-w-0 truncate text-[11px] font-semibold">{sessionName}</h2>
      <Badge variant={stream.connected ? 'default' : 'outline'} className="h-4 shrink-0 px-1 text-[8px]">
        {stream.connected ? t('company.live') : (reportedStatus ?? sessionStatus)}
      </Badge>
      {recoveredAt && (
        <Badge
          variant="outline"
          className="h-4 shrink-0 gap-1 border-amber-500/40 bg-amber-500/10 px-1 text-[8px] text-amber-700 dark:text-amber-300"
          title={t('sessionRecovered.tooltip', 'This session was paused by a server restart on {{at}}. Send a message to resume.', {
            at: formatRecoveredAt(recoveredAt),
            reason: recoveredReason,
          })}
        >
          {t('sessionRecovered.badge', 'Recovered')}
        </Badge>
      )}
      <div className="ml-auto flex items-center gap-1 shrink-0">
        {stream.connected && (
          <Button
            variant="ghost"
            size="sm"
            onClick={stream.abort}
            className="h-7 px-2 text-destructive"
          >
            <StopCircle className="h-3.5 w-3.5 mr-1" /> {t('company.stopAll')}
          </Button>
        )}
        <SessionActionsMenu
          canReconnect={canReconnect}
          onReconnect={() => stream.reattach()}
          onReestablishMaster={onReestablishMasterClick}
          onReset={onResetClick}
        />
      </div>
    </header>
  );
}

/** Format a SQLite/ISO timestamp into a short locale string. */
function formatRecoveredAt(ts: string): string {
  try {
    const iso = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? ts : d.toLocaleString();
  } catch {
    return ts;
  }
}
