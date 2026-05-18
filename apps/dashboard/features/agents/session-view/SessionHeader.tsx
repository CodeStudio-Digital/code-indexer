import { useTranslation } from 'react-i18next';
import {
  Crown,
  FolderGit2,
  Monitor,
  PanelLeft,
  PanelLeftClose,
  RefreshCw,
  RotateCcw,
  StopCircle,
  Users,
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
  agentPanelOpen: boolean;
  onToggleAgentPanel: () => void;
  /** When set, renders the preview-panel toggle button (right side). */
  previewPanelOpen?: boolean;
  onTogglePreviewPanel?: () => void;
  onResetClick: () => void;
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
  agentPanelOpen,
  onToggleAgentPanel,
  previewPanelOpen,
  onTogglePreviewPanel,
  onResetClick,
}: SessionHeaderProps) {
  const { t } = useTranslation('agents');

  const totalFronts = siblings.children.length + (siblings.parent ? 1 : 0);
  const runningFronts =
    siblings.children.filter((c) => c.status === 'running').length +
    (siblings.parent?.status === 'running' ? 1 : 0);

  return (
    <div className="px-4 py-2.5 border-b flex items-center gap-2 flex-wrap">
      <Users className="h-4 w-4 text-muted-foreground" />
      <h2 className="text-sm font-semibold">{sessionName}</h2>
      <Badge variant={stream.connected ? 'default' : 'outline'} className="text-[10px]">
        {stream.connected ? t('company.live') : (reportedStatus ?? sessionStatus)}
      </Badge>
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
      <button
        type="button"
        className={cn(
          'p-1.5 rounded-md transition-colors shrink-0',
          !stream.masterState && 'ml-auto',
          agentPanelOpen
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
        onClick={onToggleAgentPanel}
        title={t('company.toggleAgents')}
      >
        {agentPanelOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
      </button>
      {onTogglePreviewPanel && (
        <button
          type="button"
          className={cn(
            'p-1.5 rounded-md transition-colors shrink-0',
            previewPanelOpen
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
          onClick={onTogglePreviewPanel}
          title="Toggle preview panel"
        >
          <Monitor className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
