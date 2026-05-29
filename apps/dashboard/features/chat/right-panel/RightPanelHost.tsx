/**
 * Routes the active `RightPanelId` to the matching view component,
 * wrapped in `PanelChrome` so every panel shares the same header
 * (icon, title, close button).
 *
 * The host receives the same props that the old (modal-based) call
 * sites passed — sessionId, sessionData, etc. — and selects which
 * subset to forward based on the active id. Inactive panels are NOT
 * mounted (we don't lazy-keep state across switches) so fetches don't
 * keep running in the background. If we ever need to preserve scroll
 * position or partial state per panel, this is the place to add
 * mounting that respects an `mounted: Set<RightPanelId>` cache.
 */
import {
  BarChart3,
  Compass,
  Gauge,
  Info,
  ScrollText,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PanelChrome } from './PanelChrome.js';
import { SessionStateSidebar } from '../SessionStateSidebar.js';
import { SkillConfigView } from '../SkillConfigDialog.js';
import { ToolConfigView } from '../ToolConfigDialog.js';
import { SessionMetricsView } from '../SessionMetricsModal.js';
import { ToolStatsView } from '../ToolStatsModal.js';
import { SessionDetailsView } from '../SessionDetailsModal.js';
import { WorkerLogPanel } from '../WorkerLogPanel.js';
import type { RightPanelId } from './types.js';
import type { CoderSession, CoderSessionStats, SessionData } from '../types.js';
import type {
  PipelineRuntimeState,
  TodoItem,
  WorkerLogEntry,
} from '../../../hooks/agent-stream/types.js';

export interface RightPanelHostProps {
  activeId: RightPanelId;
  sessionId: number;
  session: CoderSession | null;
  sessionData: SessionData | null;
  stats: CoderSessionStats | null;
  projectId: number;
  // Meta panel deps
  refreshKey: number;
  todos: TodoItem[];
  filePicks: string[];
  onTogglePick: (path: string) => void;
  onSetManyPicks: (paths: string[], select: boolean) => void;
  onClearPicks: () => void;
  skillPicks: string[];
  onToggleSkillPick: (id: string) => void;
  pipelineRuntime: PipelineRuntimeState | null;
  // Worker log
  eventLog: readonly WorkerLogEntry[];
  onClose: () => void;
}

export function RightPanelHost(props: RightPanelHostProps) {
  const { t } = useTranslation(['chat']);
  const { activeId, sessionId, onClose } = props;

  switch (activeId) {
    case 'meta':
      return (
        <PanelChrome title={t('chat:rightRail.meta', 'Session state')} icon={Compass} onClose={onClose}>
          <SessionStateSidebar
            sessionId={sessionId}
            refreshKey={props.refreshKey}
            todos={props.todos}
            projectId={props.projectId}
            filePicks={props.filePicks}
            onTogglePick={props.onTogglePick}
            onSetManyPicks={props.onSetManyPicks}
            onClearPicks={props.onClearPicks}
            skillPicks={props.skillPicks}
            onToggleSkillPick={props.onToggleSkillPick}
            pipelineRuntime={props.pipelineRuntime}
            embedded
          />
        </PanelChrome>
      );
    case 'skills':
      return (
        <PanelChrome title={t('chat:rightRail.skills', 'Skills')} icon={Sparkles} onClose={onClose}>
          <SkillConfigView sessionId={sessionId} loadKey={props.refreshKey} />
        </PanelChrome>
      );
    case 'tools':
      return (
        <PanelChrome title={t('chat:rightRail.tools', 'Tools')} icon={Wrench} onClose={onClose}>
          <ToolConfigView sessionId={sessionId} />
        </PanelChrome>
      );
    case 'metrics':
      return (
        <PanelChrome title={t('chat:rightRail.metrics', 'Metrics')} icon={Gauge} onClose={onClose}>
          <SessionMetricsView sessionId={sessionId} active />
        </PanelChrome>
      );
    case 'tool-stats':
      return (
        <PanelChrome title={t('chat:rightRail.toolStats', 'Tool stats')} icon={BarChart3} onClose={onClose}>
          <ToolStatsView sessionId={sessionId} active />
        </PanelChrome>
      );
    case 'worker-log':
      return (
        <PanelChrome title={t('chat:rightRail.workerLog', 'Worker log')} icon={ScrollText} onClose={onClose}>
          <WorkerLogPanel entries={props.eventLog} sessionId={sessionId} onClose={onClose} embedded />
        </PanelChrome>
      );
    case 'details':
      return (
        <PanelChrome title={t('chat:rightRail.details', 'Details')} icon={Info} onClose={onClose}>
          <SessionDetailsView
            sessionId={sessionId}
            session={props.session}
            stats={props.stats}
            active
          />
        </PanelChrome>
      );
    default:
      return null;
  }
}
