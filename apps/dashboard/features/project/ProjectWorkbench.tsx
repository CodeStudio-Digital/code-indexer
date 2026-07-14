import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel, PanelGroup } from 'react-resizable-panels';
import { Brain, BookOpen } from 'lucide-react';
import type { ContribToolWindow } from '../../state/contribution-registry.js';
import { useWorkspaceLayout } from '../../state/workspace-layout.js';
import {
  WorkbenchPanelHeader,
  WorkbenchResizeHandle,
  WorkbenchShell,
  WorkbenchSurface,
} from '../../components/workbench/index.js';
import { FileTreeView } from '../workspace/file-tree/FileTreeView.js';
import { GitWindow } from '../workspace/jetbrains/tool-windows/GitWindow.js';
import { WebviewWindow } from '../workspace/jetbrains/tool-windows/WebviewWindow.js';
import { BOTTOM_BUILTIN_TAB_IDS, BottomPanel } from '../workspace/BottomPanel.js';
import { StatusBar } from '../workspace/jetbrains/StatusBar.js';
import { EditorChatRail } from './editor-chat/EditorChatRail.js';
import type { PreviewFramework } from './builder/useSelectorMode.js';
import { TransientSurface } from './tabs/TransientSurface.js';
import { ProjectPrimarySurface } from './ProjectPrimarySurface.js';
import { ProjectRail } from './ProjectRail.js';
import { ProjectRightRail } from './ProjectRightRail.js';
import { ProjectSurfaceBar } from './ProjectSurfaceBar.js';
import type { TabDef } from './tabs-config.js';
import { pluginWindowIcon } from '../workspace/plugin-icon.js';
import type { AgentChatWorkbenchSlots } from '../chat/types.js';
import type { ApiClientWorkbenchSlots } from '../api-client/workbench-slots.js';
import { DatabaseToolWindow } from '../db-client/DatabaseToolWindow.js';
import { API_RIGHT_TOOL, projectToolAvailableInContext } from './tabs-config.js';

interface ProjectWorkbenchProps {
  projectId: number;
  projectName: string;
  projectRoot?: string | null;
  initialSessionId?: number;
  activeFilePath: string | null;
  onOpenFile: (path: string) => void;
  contribWindows: ContribToolWindow[];
  builderJson: { stack: string; port: number } | null;
  previewEnabled: boolean;
  framework?: PreviewFramework;
}

function pluginTab(window: ContribToolWindow): TabDef {
  return {
    id: window.id,
    label: window.title,
    icon: pluginWindowIcon(window.icon),
    kind: window.side === 'bottom' ? 'primary' : window.side,
    group: 'plugins',
  };
}

export function ProjectWorkbench(props: ProjectWorkbenchProps) {
  const layout = useWorkspaceLayout();
  const [sessionsHost, setSessionsHost] = useState<HTMLDivElement | null>(null);
  const [databaseHost, setDatabaseHost] = useState<HTMLDivElement | null>(null);
  const [gitHost, setGitHost] = useState<HTMLDivElement | null>(null);
  const [apiLeftHost, setApiLeftHost] = useState<HTMLDivElement | null>(null);
  const [apiRightHost, setApiRightHost] = useState<HTMLDivElement | null>(null);
  const [sessionRightPanelHost, setSessionRightPanelHost] = useState<HTMLDivElement | null>(null);
  const [sessionRightRailHost, setSessionRightRailHost] = useState<HTMLDivElement | null>(null);
  const [sessionState, setSessionState] = useState({ hasSession: !!props.initialSessionId, rightPanelOpen: false });
  const sessionsMode = layout.primarySurface === 'sessions';
  const apiMode = layout.primarySurface === 'api';
  const handleSessionStateChange = useCallback((next: { hasSession: boolean; rightPanelOpen: boolean }) => {
    setSessionState((current) =>
      current.hasSession === next.hasSession && current.rightPanelOpen === next.rightPanelOpen ? current : next,
    );
  }, []);
  const handleSessionSelected = useCallback(() => {
    const state = useWorkspaceLayout.getState();
    state.setPrimarySurface('sessions');
    if (state.activeRight === 'chat') state.setActiveRight(null);
  }, []);
  const handleToggleLeft = useCallback((id: string) => {
    const state = useWorkspaceLayout.getState();
    const opening = state.activeLeft !== id;
    state.toggleLeft(id);
    if (id === 'sessions' && opening) {
      state.setPrimarySurface('sessions');
      if (state.activeRight === 'chat') state.setActiveRight(null);
    } else if (id === 'databases' && opening) {
      state.setPrimarySurface('editor');
    } else if (id === 'api-navigation' && opening) {
      state.setPrimarySurface('api');
      state.setActiveRight('api-inspector');
    }
  }, []);
  const handlePrimarySelect = useCallback((id: string) => {
    const state = useWorkspaceLayout.getState();
    state.setPrimarySurface(id);
    if (id === 'api') {
      state.setActiveLeft('api-navigation');
      state.setActiveRight('api-inspector');
      return;
    }
    if (state.activeLeft === 'api-navigation') state.setActiveLeft(null);
    if (state.activeRight === 'api-inspector') state.setActiveRight(null);
    if (id === 'sessions') {
      state.setActiveLeft('sessions');
      if (state.activeRight === 'chat') state.setActiveRight(null);
    }
  }, []);
  const closeApiLeft = useCallback(() => useWorkspaceLayout.getState().setActiveLeft(null), []);
  const closeApiRight = useCallback(() => useWorkspaceLayout.getState().setActiveRight(null), []);
  const apiWorkbenchSlots = useMemo<ApiClientWorkbenchSlots>(() => ({
    leftHost: apiLeftHost,
    rightHost: apiRightHost,
    onCloseLeft: closeApiLeft,
    onCloseRight: closeApiRight,
  }), [apiLeftHost, apiRightHost, closeApiLeft, closeApiRight]);
  const sessionWorkbenchSlots = useMemo<AgentChatWorkbenchSlots>(() => ({
    sessionsHost,
    rightPanelHost: sessionRightPanelHost,
    rightRailHost: sessionRightRailHost,
    onSessionStateChange: handleSessionStateChange,
    onSessionSelected: handleSessionSelected,
  }), [handleSessionSelected, handleSessionStateChange, sessionRightPanelHost, sessionRightRailHost, sessionsHost]);
  const leftPlugins = useMemo(
    () => props.contribWindows.filter((window) => window.side === 'left'),
    [props.contribWindows],
  );
  const rightPlugins = useMemo(
    () => props.contribWindows.filter((window) => window.side === 'right'),
    [props.contribWindows],
  );
  const bottomPlugins = useMemo(
    () => props.contribWindows.filter((window) => window.side === 'bottom'),
    [props.contribWindows],
  );

  const activeLeftPlugin = leftPlugins.find((window) => window.id === layout.activeLeft);
  const activeRightPlugin = rightPlugins.find((window) => window.id === layout.activeRight);
  const leftKnown =
    layout.activeLeft === 'files' ||
    layout.activeLeft === 'sessions' ||
    layout.activeLeft === 'api-navigation' ||
    layout.activeLeft === 'databases' ||
    layout.activeLeft === 'git' ||
    !!activeLeftPlugin;
  const rightKnown =
    layout.activeRight === 'chat' ||
    layout.activeRight === 'snapshots' ||
    layout.activeRight === 'memory' ||
    layout.activeRight === 'api-inspector' ||
    !!activeRightPlugin;
  const bottomKnown = !!layout.activeBottom && (
    BOTTOM_BUILTIN_TAB_IDS.has(layout.activeBottom) ||
    bottomPlugins.some((window) => window.id === layout.activeBottom)
  );

  useEffect(() => {
    if (layout.activeLeft && !leftKnown) layout.setActiveLeft(null);
  }, [layout.activeLeft, leftKnown, layout.setActiveLeft]);
  useEffect(() => {
    if (layout.activeRight && !rightKnown) layout.setActiveRight(null);
  }, [layout.activeRight, rightKnown, layout.setActiveRight]);
  useEffect(() => {
    if (layout.activeBottom && !bottomKnown) layout.setActiveBottom(null);
  }, [bottomKnown, layout.activeBottom, layout.setActiveBottom]);
  useEffect(() => {
    const state = useWorkspaceLayout.getState();
    if (layout.primarySurface === 'api') {
      if (state.activeLeft !== 'api-navigation') state.setActiveLeft('api-navigation');
      if (state.activeRight !== 'api-inspector') state.setActiveRight('api-inspector');
      return;
    }
    if (state.activeLeft === 'api-navigation') state.setActiveLeft(null);
    if (state.activeRight === 'api-inspector') state.setActiveRight(null);
  }, [layout.primarySurface]);
  useEffect(() => {
    if (layout.primarySurface === 'preview' && !props.previewEnabled) layout.setPrimarySurface('editor');
  }, [layout.primarySurface, layout.setPrimarySurface, props.previewEnabled]);
  useEffect(() => {
    // v2/deep-link compatibility: Database is now a left tool window whose
    // objects open in the editor, never a dedicated primary surface.
    if (layout.primarySurface !== 'databases') return;
    layout.setPrimarySurface('editor');
    layout.setActiveLeft('databases');
  }, [layout.primarySurface, layout.setActiveLeft, layout.setPrimarySurface]);
  useEffect(() => {
    if ((sessionsMode || sessionState.hasSession) && layout.activeRight === 'chat') {
      layout.setActiveRight(null);
    }
  }, [layout.activeRight, layout.setActiveRight, sessionState.hasSession, sessionsMode]);

  const renderLeft = () => {
    if (layout.activeLeft === 'files') {
      return (
        <FileTreeView
          projectId={props.projectId}
          active
          activePath={props.activeFilePath}
          projectRoot={props.projectRoot}
          onOpen={props.onOpenFile}
          onClose={() => layout.setActiveLeft(null)}
        />
      );
    }
    if (layout.activeLeft === 'git') {
      return <div key="git" ref={setGitHost} className="h-full min-h-0 overflow-hidden" />;
    }
    if (layout.activeLeft === 'sessions') {
      return <div key="sessions" ref={setSessionsHost} className="h-full min-h-0 overflow-hidden" />;
    }
    if (layout.activeLeft === 'api-navigation') {
      return <div key="api-navigation" ref={setApiLeftHost} className="h-full min-h-0 overflow-hidden" />;
    }
    if (layout.activeLeft === 'databases') {
      return <div key="databases" ref={setDatabaseHost} className="h-full min-h-0 overflow-hidden" />;
    }
    if (activeLeftPlugin) {
      return (
        <WebviewWindow
          namespace={activeLeftPlugin.pluginNs}
          title={activeLeftPlugin.title}
          entry={activeLeftPlugin.entry}
          projectId={props.projectId}
          onClose={() => layout.setActiveLeft(null)}
        />
      );
    }
    return null;
  };

  const renderRight = () => {
    if (sessionsMode) {
      return <div key="session-details" ref={setSessionRightPanelHost} className="h-full min-h-0 overflow-hidden" />;
    }
    if (apiMode) {
      return <div key="api-inspector" ref={setApiRightHost} className="h-full min-h-0 overflow-hidden" />;
    }
    if (layout.activeRight === 'chat') {
      return (
        <EditorChatRail
          projectId={props.projectId}
          projectName={props.projectName}
          onClose={() => layout.setActiveRight(null)}
        />
      );
    }
    if (layout.activeRight === 'snapshots' || layout.activeRight === 'memory') {
      const snapshots = layout.activeRight === 'snapshots';
      return (
        <div className="flex h-full min-h-0 flex-col">
          <WorkbenchPanelHeader
            title={snapshots ? 'Snapshots' : 'Memory'}
            icon={snapshots ? BookOpen : Brain}
            onClose={() => layout.setActiveRight(null)}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            <TransientSurface
              tab={layout.activeRight}
              projectId={props.projectId}
              projectName={props.projectName}
              contribWindows={props.contribWindows}
              builderJson={props.builderJson}
              framework={props.framework}
            />
          </div>
        </div>
      );
    }
    if (activeRightPlugin) {
      return (
        <WebviewWindow
          namespace={activeRightPlugin.pluginNs}
          title={activeRightPlugin.title}
          entry={activeRightPlugin.entry}
          projectId={props.projectId}
          onClose={() => layout.setActiveRight(null)}
        />
      );
    }
    return null;
  };

  const leftOpen = !!layout.activeLeft
    && leftKnown
    && projectToolAvailableInContext(layout.activeLeft, layout.primarySurface);
  const rightOpen = sessionsMode
    ? sessionState.hasSession && sessionState.rightPanelOpen
    : apiMode
      ? layout.activeRight === 'api-inspector'
    : !!layout.activeRight
      && rightKnown
      && projectToolAvailableInContext(layout.activeRight, layout.primarySurface)
      && layout.activeRight !== 'api-inspector';

  return (
    <WorkbenchShell>
      <DatabaseToolWindow
        key={props.projectId}
        projectId={props.projectId}
        projectName={props.projectName}
        host={databaseHost}
      />
      <GitWindow
        key={`git-${props.projectId}`}
        projectId={props.projectId}
        host={gitHost}
        active={layout.activeLeft === 'git'}
        onClose={() => layout.setActiveLeft(null)}
      />
      <div className="flex min-h-0 flex-1">
        <ProjectRail
          projectId={props.projectId}
          activeTool={layout.activeLeft}
          onToggle={handleToggleLeft}
          bottomOpen={layout.activeBottom !== null}
          onToggleBottom={() => layout.toggleBottom('terminal')}
          pluginTabs={leftPlugins.map(pluginTab)}
        />
        <div className="min-w-0 flex-1 p-1.5">
          <PanelGroup direction="vertical" autoSaveId={`mcp-workbench-vertical-${props.projectId}`}>
            <Panel id="workbench-main" order={1} minSize={28} className="min-h-0">
              <PanelGroup direction="horizontal" autoSaveId={`mcp-workbench-horizontal-${props.projectId}`}>
                {leftOpen && (
                  <>
                    <Panel id="left-dock" order={1} defaultSize={20} minSize={12} maxSize={38} className="min-w-0">
                      <WorkbenchSurface className="h-full">{renderLeft()}</WorkbenchSurface>
                    </Panel>
                    <WorkbenchResizeHandle direction="horizontal" />
                  </>
                )}
                <Panel id="primary" order={2} minSize={34} className="min-w-0">
                  <WorkbenchSurface className="flex h-full flex-col">
                    <ProjectSurfaceBar
                      active={layout.primarySurface}
                      onSelect={handlePrimarySelect}
                      previewEnabled={props.previewEnabled}
                    />
                    <div className="min-h-0 flex-1">
                      <ProjectPrimarySurface
                        surface={layout.primarySurface}
                        projectId={props.projectId}
                        projectName={props.projectName}
                        initialSessionId={props.initialSessionId}
                        contribWindows={props.contribWindows}
                        builderJson={props.builderJson}
                        previewEnabled={props.previewEnabled}
                        framework={props.framework}
                        sessionsRequested={layout.activeLeft === 'sessions'}
                        sessionWorkbenchSlots={sessionWorkbenchSlots}
                        apiWorkbenchSlots={apiWorkbenchSlots}
                      />
                    </div>
                  </WorkbenchSurface>
                </Panel>
                {rightOpen && (
                  <>
                    <WorkbenchResizeHandle direction="horizontal" />
                    <Panel id="right-dock" order={3} defaultSize={26} minSize={20} maxSize={46} className="min-w-0">
                      <WorkbenchSurface className="h-full">{renderRight()}</WorkbenchSurface>
                    </Panel>
                  </>
                )}
              </PanelGroup>
            </Panel>
            {layout.activeBottom && bottomKnown && (
              <>
                <WorkbenchResizeHandle direction="vertical" />
                <Panel id="bottom-dock" order={2} defaultSize={28} minSize={12} maxSize={62} className="min-h-0">
                  <WorkbenchSurface className="h-full">
                    <BottomPanel
                      projectId={props.projectId}
                      isOpen
                      onToggle={() => layout.toggleBottom(layout.activeBottom!)}
                      onClose={() => layout.setActiveBottom(null)}
                      onOpenFile={props.onOpenFile}
                      pluginWindows={bottomPlugins}
                    />
                  </WorkbenchSurface>
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>
        {sessionsMode ? (
          sessionState.hasSession && <div ref={setSessionRightRailHost} className="contents" />
        ) : apiMode ? (
          <ProjectRightRail
            activeTool={layout.activeRight}
            onToggle={layout.toggleRight}
            pluginTabs={[]}
            tabs={[API_RIGHT_TOOL]}
          />
        ) : (
          <ProjectRightRail
            activeTool={layout.activeRight}
            onToggle={layout.toggleRight}
            pluginTabs={rightPlugins.map(pluginTab)}
            hideChat={sessionState.hasSession}
          />
        )}
      </div>
      <StatusBar projectId={props.projectId} projectName={props.projectName} />
    </WorkbenchShell>
  );
}
