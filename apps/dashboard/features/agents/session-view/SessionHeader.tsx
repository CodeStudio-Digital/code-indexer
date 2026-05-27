import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Crown,
  FolderGit2,
  PanelLeft,
  PanelLeftClose,
  RefreshCw,
  RotateCcw,
  StopCircle,
  TerminalSquare,
  Users,
  Wrench,
} from 'lucide-react';
import { Badge } from '../../../components/ui/badge.js';
import { Button } from '../../../components/ui/button.js';
import { cn } from '../../../lib/utils.js';
import { QaRunBadge } from '../tests/shared/QaRunBadge.js';
import type { useCompanyStream } from '../../../hooks/useCompanyStream.js';
import type { useCompanySiblings } from '../../../hooks/useCompanySiblings.js';
import type { SessionProject } from './types.js';

interface SessionHeaderProps {
  sessionId: number;
  sessionName: string;
  sessionStatus: string;
  /** Backend-reported status; falls back to `sessionStatus` when unloaded. */
  reportedStatus?: string;
  projects?: SessionProject[];
  stream: ReturnType<typeof useCompanyStream>;
  siblings: ReturnType<typeof useCompanySiblings>;
  /**
   * Outer-app toggle: shows/hides the sessions-list sidebar owned by
   * `AgentsTab`. When omitted (e.g. on routes that don't sit inside
   * AgentsTab) the button is hidden.
   */
  sessionsListOpen?: boolean;
  onToggleSessionsList?: () => void;
  /**
   * Bottom-terminal toggle — opens/closes the resizable terminal panel
   * mounted below the zone content. Mirrors Workspace's
   * `bottomPanelOpen` knob.
   */
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
  /**
   * P15c — ISO timestamp set by the boot-time recovery sweep when the
   * server restart caught this session in `running` status. Renders a
   * "Recovered" pill so the user understands why the session is paused.
   */
  recoveredAt?: string | null;
  recoveredReason?: string | null;
  onResetClick: () => void;
  /**
   * Phase H — when set, the header shows a "Reestabelecer Master" button
   * that spawns the master-recovery agent. Provided by the parent only
   * when this is a master view (companyContext.isMaster === true).
   * Click invokes the callback, which navigates to the new session.
   */
  onReestablishMasterClick?: () => void | Promise<void>;
}

/**
 * Top bar of the company-session view: session name + live status badge,
 * project chips, master role badge, stop/reconnect/reset actions, agent
 * panel toggle. Extracted from `CompanySessionView` so the shell can
 * focus on layout composition.
 */
export function SessionHeader({
  sessionId,
  sessionName,
  sessionStatus,
  reportedStatus,
  projects,
  stream,
  siblings,
  sessionsListOpen,
  terminalOpen,
  onToggleTerminal,
  onToggleSessionsList,
  recoveredAt,
  recoveredReason,
  onResetClick,
  onReestablishMasterClick,
}: SessionHeaderProps) {
  const { t } = useTranslation('agents');
  const [reestablishing, setReestablishing] = useState(false);
  const handleReestablish = useCallback(async () => {
    if (!onReestablishMasterClick || reestablishing) return;
    const ok = window.confirm(
      'Spawn um agente de Recovery que vai auditar o kanban + master state e reparar inconsistências. ' +
      'O agente roda em uma session NOVA (a atual fica intocada). Continuar?',
    );
    if (!ok) return;
    setReestablishing(true);
    try {
      await onReestablishMasterClick();
    } finally {
      setReestablishing(false);
    }
  }, [onReestablishMasterClick, reestablishing]);

  const totalFronts = siblings.children.length + (siblings.parent ? 1 : 0);
  const runningFronts =
    siblings.children.filter((c) => c.status === 'running').length +
    (siblings.parent?.status === 'running' ? 1 : 0);

  return (
    <div className="px-4 py-2.5 border-b flex items-center gap-2 flex-wrap">
      {onToggleSessionsList && (
        <button
          type="button"
          className={cn(
            'p-1.5 rounded-md transition-colors shrink-0',
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
      {/* Agents-panel toggle removed — the same affordance now lives in
          the right-side icon rail (Building2 icon for 'company-config'),
          where the panel itself was moved. Keeping the button here too
          duplicated the action and confused the navigation. */}
      <Users className="h-4 w-4 text-muted-foreground" />
      <h2 className="text-sm font-semibold">{sessionName}</h2>
      <Badge variant={stream.connected ? 'default' : 'outline'} className="text-[10px]">
        {stream.connected ? t('company.live') : (reportedStatus ?? sessionStatus)}
      </Badge>
      {recoveredAt && (
        <Badge
          variant="outline"
          className="text-[10px] gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          title={t('sessionRecovered.tooltip', 'This session was paused by a server restart on {{at}}. Send a message to resume.', {
            at: formatRecoveredAt(recoveredAt),
            reason: recoveredReason,
          })}
        >
          {t('sessionRecovered.badge', 'Recovered')}
        </Badge>
      )}
      {totalFronts > 1 && runningFronts > 0 && (
        <span className="text-[10px] text-muted-foreground">
          {runningFronts}/{totalFronts} fronts
        </span>
      )}
      {projects?.map((p) => (
        <Badge key={p.project_id} variant="outline" className="text-[10px] gap-1">
          <FolderGit2 className="h-2.5 w-2.5" />
          {p.project_name}
        </Badge>
      ))}
      <QaRunBadge sessionId={sessionId} />
      {stream.masterState && (
        <Badge variant="outline" className="text-[10px] ml-auto gap-1 capitalize">
          <Crown className="h-2.5 w-2.5 text-yellow-400" />
          Master: {stream.masterState.status}
        </Badge>
      )}
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
      {!stream.connected && sessionStatus === 'running' && stream.started && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => stream.reattach()}
          className="h-7 px-2 text-muted-foreground"
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1" /> {t('company.reconnect')}
        </Button>
      )}
      {/* Terminal toggle — opens/closes the resizable bottom panel. */}
      {onToggleTerminal && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleTerminal}
          className={cn(
            'h-7 px-2',
            terminalOpen ? 'text-foreground bg-muted' : 'text-muted-foreground',
          )}
          title={
            terminalOpen
              ? 'Fechar terminal embutido (Ctrl+J)'
              : 'Abrir terminal embutido (Ctrl+J)'
          }
        >
          <TerminalSquare className="h-3.5 w-3.5 mr-1" /> Terminal
        </Button>
      )}
      {/* Phase H — Master Recovery: spawns a one-shot agent that audits
          the kanban + state and repairs inconsistencies. Visible only when
          this view is a company master (parent passes the callback). */}
      {onReestablishMasterClick && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleReestablish()}
          disabled={reestablishing}
          className="h-7 px-2 text-amber-700 dark:text-amber-300"
          title="Reestabelecer Master — spawn um agent de recovery que audita kanban + state e repara cards/goal"
        >
          {reestablishing ? (
            <RefreshCw className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <Wrench className="h-3.5 w-3.5 mr-1" />
          )}
          {reestablishing ? 'Spawning…' : 'Reestabelecer Master'}
        </Button>
      )}
      {/* Reset: archives the current conversation state and flips the session
          back to idle so the next prompt starts fresh with current system
          prompts. Useful after template/prompt updates. */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onResetClick}
        className="h-7 px-2 text-muted-foreground"
        title="Resetar sessão — arquiva conversas e permite recomeçar do zero"
      >
        <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reset
      </Button>
    </div>
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
