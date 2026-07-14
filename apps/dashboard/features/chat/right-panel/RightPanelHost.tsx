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
  Bell,
  BookOpen,
  ClipboardList,
  Compass,
  Gauge,
  HardDrive,
  Info,
  ScrollText,
  Settings,
  Workflow,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PanelChrome } from './PanelChrome.js';
import { SessionStateSidebar } from '../SessionStateSidebar.js';
import { SessionDriveView } from '../SessionDrivePanel.js';
import { SessionConfigView } from './SessionConfigPanel.js';
import { SessionMetricsView } from '../SessionMetricsModal.js';
import { ToolStatsView } from '../ToolStatsModal.js';
import { SessionDetailsView } from '../SessionDetailsModal.js';
import { PlansPanel } from './PlansPanel.js';
import { DiagramPanel } from './diagram/DiagramPanel.js';
import { WorkerLogPanel } from '../WorkerLogPanel.js';
import { NotificationsPanel } from '../notifications/NotificationsPanel.js';
import { ConversationChaptersPanel } from '../messages/ConversationChapters.js';
import { WebviewWindow } from '../../workspace/jetbrains/tool-windows/WebviewWindow.js';
import { pluginWindowIcon } from '../../workspace/plugin-icon.js';
import type { ContribToolWindow } from '../../../state/contribution-registry.js';
import type { RightPanelId } from './types.js';
import type { CoderSession, CoderSessionStats, SessionData } from '../types.js';
import type {
  PipelineRuntimeState,
  TodoItem,
} from '../../../hooks/agent-stream/types.js';

export interface RightPanelHostProps {
  activeId: RightPanelId;
  sessionId: number;
  session: CoderSession | null;
  sessionData: SessionData | null;
  stats: CoderSessionStats | null;
  /** Null in a global session before a linked project is active. */
  projectId: number | null;
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
  /** Plugin tool windows (side: 'right') the rail can activate. */
  pluginWindows?: ContribToolWindow[];
  onClose: () => void;
}

export function RightPanelHost(props: RightPanelHostProps) {
  const { t } = useTranslation(['chat']);
  const { activeId, sessionId, onClose } = props;

  // Plugin-contributed panel → its sandboxed webview inside the shared
  // chrome (chromeless webview: PanelChrome already renders title + close).
  if (activeId.startsWith('plugin:')) {
    const win = (props.pluginWindows ?? []).find(
      (w) => `plugin:${w.pluginNs}:${w.id}` === activeId,
    );
    if (!win) return null; // uninstalled/disabled — usePluginPanels resets the id
    return (
      <PanelChrome title={win.title} icon={pluginWindowIcon(win.icon)} onClose={onClose}
        bodyClassName="overflow-hidden">
        <WebviewWindow
          namespace={win.pluginNs}
          title={win.title}
          entry={win.entry}
          {...(props.projectId == null ? {} : { projectId: props.projectId })}
          chromeless
        />
      </PanelChrome>
    );
  }

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
    case 'drive':
      return (
        <PanelChrome title={t('chat:rightRail.drive', 'Drive')} icon={HardDrive} onClose={onClose}>
          <SessionDriveView sessionId={sessionId} active />
        </PanelChrome>
      );
    case 'chapters':
      return (
        <PanelChrome title={t('chat:rightRail.chapters', 'Chapters')} icon={BookOpen} onClose={onClose}
          bodyClassName="overflow-hidden">
          <ConversationChaptersPanel
            sessionId={sessionId}
            sessionStatus={props.session?.status}
            fallbackSummary={props.session?.compaction_summary}
          />
        </PanelChrome>
      );
    case 'config':
      return (
        <PanelChrome title={t('chat:rightRail.config', 'Configuration')} icon={Settings} onClose={onClose}>
          <SessionConfigView sessionId={sessionId} loadKey={props.refreshKey} />
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
    case 'plans':
      return (
        <PanelChrome title={t('chat:rightRail.plans', 'Plans')} icon={ClipboardList} onClose={onClose}>
          <PlansPanel sessionId={sessionId} active />
        </PanelChrome>
      );
    case 'notifications':
      return (
        <PanelChrome title={t('chat:rightRail.notifications', 'Notifications')} icon={Bell} onClose={onClose}>
          <NotificationsPanel sessionId={sessionId} />
        </PanelChrome>
      );
    case 'worker-log':
      return (
        <PanelChrome title={t('chat:rightRail.workerLog', 'Worker log')} icon={ScrollText} onClose={onClose}>
          <WorkerLogPanel sessionId={sessionId} onClose={onClose} embedded />
        </PanelChrome>
      );
    case 'diagram':
      return (
        <PanelChrome title={t('chat:rightRail.diagram', 'Diagram')} icon={Workflow} onClose={onClose}
          bodyClassName="overflow-hidden">
          <DiagramPanel sessionId={sessionId} projectId={props.projectId} />
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
