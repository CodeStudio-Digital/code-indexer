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
import { Bell, Bot, BookOpen, ChartNoAxesCombined, ClipboardList, Compass, HardDrive, ScrollText, Settings, Workflow } from 'lucide-react';
import { lazy, memo, Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelChrome } from './PanelChrome.js';
import { ConversationChaptersPanel } from '../messages/ConversationChapters.js';

/**
 * Every rail panel is its own async chunk.
 *
 * At most ONE panel is mounted at a time (see the switch below — inactive
 * panels are deliberately never kept alive), yet static imports put all of them
 * in the chat's eager bundle: session metrics + tool stats + session details,
 * the draw.io diagram host, the worker-log execution map, the drive tabs. That
 * was ~600 KB the user paid for on every session open just to read a message.
 * A rail panel is always opened by an explicit click, so a one-frame Suspense
 * fallback is invisible in practice.
 *
 * `ConversationChaptersPanel` stays eager: `MessageList` imports the chapter
 * divider from the same module, so it is already in this chunk regardless.
 */
const SessionStateSidebar = lazy(() =>
  import('../SessionStateSidebar.js').then((m) => ({ default: m.SessionStateSidebar })),
);
const SessionDriveView = lazy(() =>
  import('../SessionDrivePanel.js').then((m) => ({ default: m.SessionDriveView })),
);
const SessionConfigView = lazy(() =>
  import('./SessionConfigPanel.js').then((m) => ({ default: m.SessionConfigView })),
);
const SessionInsightsPanel = lazy(() =>
  import('./SessionInsightsPanel.js').then((m) => ({ default: m.SessionInsightsPanel })),
);
const PlansPanel = lazy(() => import('./PlansPanel.js').then((m) => ({ default: m.PlansPanel })));
const DiagramPanel = lazy(() =>
  import('./diagram/DiagramPanel.js').then((m) => ({ default: m.DiagramPanel })),
);
const WorkerLogPanel = lazy(() =>
  import('../WorkerLogPanel.js').then((m) => ({ default: m.WorkerLogPanel })),
);
const NotificationsPanel = lazy(() =>
  import('../notifications/NotificationsPanel.js').then((m) => ({ default: m.NotificationsPanel })),
);
const ChatCollaborationPanel = lazy(() => import('./ChatCollaborationPanel.js').then(m => ({ default: m.ChatCollaborationPanel })));
const SubagentsPanel = lazy(() =>
  import('./SubagentsPanel.js').then((m) => ({ default: m.SubagentsPanel })),
);
const ProjectPreview = lazy(() =>
  import('../../project/builder/ProjectPreview.js').then((m) => ({ default: m.ProjectPreview })),
);

/** Panel-body placeholder. Sits INSIDE `PanelChrome` so the header (title +
 *  close button) never blinks while the chunk resolves. */
function PanelBody({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={(
        <div className="grid h-full min-h-24 place-items-center" aria-busy="true">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted border-t-primary" />
        </div>
      )}
    >
      {children}
    </Suspense>
  );
}
import { WebviewWindow } from '../../workspace/jetbrains/tool-windows/WebviewWindow.js';
import { pluginWindowIcon } from '../../workspace/plugin-icon.js';
import type { ContribToolWindow } from '../../../state/contribution-registry.js';
import type { RightPanelId } from './types.js';
import type { AgentChatPreviewConfig, CoderSession, CoderSessionStats, SessionData } from '../types.js';
import type { ActiveProcess, TodoItem } from '../../../hooks/agent-stream/types.js';
import { useAgentCurrentTurn } from '../../../hooks/useAgentStream.js';

interface RightPanelHostProps {
  activeId: RightPanelId;
  sessionId: string;
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
  activeProcesses: ActiveProcess[];
  /** Plugin tool windows (side: 'right') the rail can activate. */
  pluginWindows?: ContribToolWindow[];
  /** Live preview contributed by the hosting project. */
  preview?: AgentChatPreviewConfig;
  onClose: () => void;
}

export const RightPanelHost = memo(function RightPanelHost(props: RightPanelHostProps) {
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
          <PanelBody>
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
              activeProcesses={props.activeProcesses}
              embedded
            />
          </PanelBody>
        </PanelChrome>
      );
    case 'preview':
      if (!props.preview || props.projectId == null) return null;
      return (
        <PanelBody>
          <ProjectPreview
            key={props.projectId}
            projectId={props.projectId}
            pinnedPort={props.preview.pinnedPort}
            selectionEnabled={props.preview.selectionEnabled}
            framework={props.preview.framework}
            onHide={onClose}
          />
        </PanelBody>
      );
    case 'drive':
      return (
        <PanelChrome title={t('chat:rightRail.drive', 'Drive')} icon={HardDrive} onClose={onClose}>
          <PanelBody>
            <SessionDriveView sessionId={sessionId} active />
          </PanelBody>
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
          <PanelBody>
            <SessionConfigView sessionId={sessionId} loadKey={props.refreshKey} />
          </PanelBody>
        </PanelChrome>
      );
    case 'insights':
      return (
        <PanelChrome
          title={t('chat:rightRail.insights', 'Session insights')}
          icon={ChartNoAxesCombined}
          onClose={onClose}
          bodyClassName="overflow-hidden"
        >
          <PanelBody>
            <SessionInsightsPanel
              sessionId={sessionId}
              session={props.session}
              stats={props.stats}
            />
          </PanelBody>
        </PanelChrome>
      );
    case 'collaboration':
      return <PanelChrome title={t('chat:collaboration.title')} icon={Bot} onClose={onClose} bodyClassName="overflow-hidden">
        <PanelBody><ChatCollaborationPanel key={sessionId} sessionId={sessionId} /></PanelBody>
      </PanelChrome>;
    case 'subagents':
      return (
        <PanelChrome
          title={t('chat:rightRail.subagents', 'Subagents')}
          icon={Bot}
          onClose={onClose}
          bodyClassName="overflow-hidden"
        >
          <PanelBody>
            <LiveSubagentsPanel sessionId={sessionId} sessionData={props.sessionData} />
          </PanelBody>
        </PanelChrome>
      );
    case 'plans':
      return (
        <PanelChrome title={t('chat:rightRail.plans', 'Plans')} icon={ClipboardList} onClose={onClose}>
          <PanelBody>
            <PlansPanel sessionId={sessionId} active />
          </PanelBody>
        </PanelChrome>
      );
    case 'notifications':
      return (
        <PanelChrome title={t('chat:rightRail.notifications', 'Notifications')} icon={Bell} onClose={onClose}>
          <PanelBody>
            <NotificationsPanel sessionId={sessionId} />
          </PanelBody>
        </PanelChrome>
      );
    case 'worker-log':
      return (
        <PanelChrome title={t('chat:rightRail.workerLog', 'Worker log')} icon={ScrollText} onClose={onClose}>
          <PanelBody>
            <WorkerLogPanel sessionId={sessionId} onClose={onClose} embedded />
          </PanelBody>
        </PanelChrome>
      );
    case 'diagram':
      return (
        <PanelChrome title={t('chat:rightRail.diagram', 'Diagram')} icon={Workflow} onClose={onClose}
          bodyClassName="overflow-hidden">
          <PanelBody>
            <DiagramPanel sessionId={sessionId} projectId={props.projectId} />
          </PanelBody>
        </PanelChrome>
      );
    default:
      return null;
  }
});

function LiveSubagentsPanel({
  sessionId,
  sessionData,
}: {
  sessionId: string;
  sessionData: SessionData | null;
}) {
  const currentTurn = useAgentCurrentTurn(sessionId);
  return <SubagentsPanel sessionData={sessionData} currentTurn={currentTurn} />;
}
