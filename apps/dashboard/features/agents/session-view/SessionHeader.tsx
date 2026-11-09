import { useTranslation } from 'react-i18next';
import { Pause, Play, Users } from 'lucide-react';
import { Badge } from '../../../components/ui/badge.js';
import { Button } from '../../../components/ui/button.js';
import { formatDateTime } from '../../../lib/datetime.js';
import { SessionActionsMenu } from './SessionActionsMenu.js';
import type { useCompanyStream } from '../../../hooks/useCompanyStream.js';

interface SessionHeaderProps {
  sessionName: string;
  companyName?: string;
  onPause?: () => void;
  onResume?: () => void;
  sessionStatus: string;
  /** Backend-reported status; falls back to `sessionStatus` when unloaded. */
  reportedStatus?: string;
  stream: ReturnType<typeof useCompanyStream>;
  /**
   * P15c — ISO timestamp set by the boot-time recovery sweep when the
   * server restart caught this session in `running` status. Renders a
   * "Recovered" pill so the user understands why the session is paused.
   */
  recoveredAt?: string | null;
  recoveredReason?: string | null;
  onResetClick?: () => void;
  /** App-owned teams use per-card controls in App Studio, never Company abort-all. */
  allowAbort?: boolean;
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
  companyName,
  onPause,
  onResume,
  sessionStatus,
  reportedStatus,
  stream,
  recoveredAt,
  recoveredReason,
  onResetClick,
  allowAbort = true,
  onReestablishMasterClick,
}: SessionHeaderProps) {
  const { t } = useTranslation('agents');

  // Reconnect surfaces only when the session is running but the live SSE
  // stream dropped — moved into the overflow menu to keep the bar lean.
  const canReconnect = !stream.connected && sessionStatus === 'running' && stream.started;

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-3">
      <Users className="h-4 w-4 text-muted-foreground shrink-0" />
      {companyName && <><span className="truncate text-xs text-muted-foreground">{companyName}</span><span className="text-muted-foreground/50">/</span></>}
      <h2 className="min-w-0 truncate text-[11px] font-semibold">{sessionName}</h2>
      <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[9px]">
        {t(`status.${stream.masterAlive ? 'running' : reportedStatus ?? sessionStatus}`, reportedStatus ?? sessionStatus)}
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
        {allowAbort && (stream.masterAlive || sessionStatus === 'running') && onPause && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onPause}
            className="h-7 px-2"
          >
            <Pause className="h-3.5 w-3.5 mr-1" /> {t('company.pauseSession', 'Pause session')}
          </Button>
        )}
        {allowAbort && sessionStatus === 'paused' && !stream.masterAlive && onResume && <Button variant="outline" size="sm" className="h-7 px-2" onClick={onResume}><Play className="mr-1 size-3.5" />{t('company.resumeSession', 'Resume')}</Button>}
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

/** Format a SQLite/ISO timestamp into a short locale string (local timezone). */
function formatRecoveredAt(ts: string): string {
  try {
    return formatDateTime(ts, undefined, undefined, ts);
  } catch {
    return ts;
  }
}
