import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel, PanelGroup } from 'react-resizable-panels';
import { Brain } from 'lucide-react';
import type { ContribToolWindow } from '../../state/contribution-registry.js';
import { useWorkspaceLayout } from '../../state/workspace-layout.js';
import { useWorktreeSelection, worktreeKey, type WorktreeSelection } from '../../state/worktree-selection.js';
import { SessionWorkspaceBar } from '../chat/SessionWorkspaceBar.js';
import { useWorktreeInventory } from '../chat/useSessionWorktrees.js';
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
import type { TabDef } from './tabs-config.js';
import { pluginWindowIcon } from '../workspace/plugin-icon.js';
import type { AgentChatWorkbenchSlots } from '../chat/types.js';
import type { ApiClientWorkbenchSlots } from '../api-client/workbench-slots.js';
import { DatabaseToolWindow } from '../db-client/DatabaseToolWindow.js';
import { API_RIGHT_TOOL } from './tabs-config.js';
import { usePortalHost } from '../../hooks/usePortalHost.js';

interface ProjectWorkbenchProps {
  projectId: number;
  projectName: string;
  projectRoot?: string | null;
  mainRoot?: string | null;
  workspaceId?: number | null;
  workspaceError?: string;
  worktreeSelection?: WorktreeSelection;
  initialSessionId?: string;
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

function ProjectCheckoutBar({ projectId, selection }: { projectId: number; selection: WorktreeSelection }) {
  const { data, loading, error, refetch } = useWorktreeInventory(projectId);
  if (!data?.isGit && !selection.path) return null;
  const unavailable = !!selection.path && !loading && !data?.worktrees.some(
    (item) => !item.prunable && worktreeKey(item.path) === worktreeKey(selection.path),
  );
  return (
    <SessionWorkspaceBar
      key={projectId}
      projectId={projectId}
      isGlobal={false}
      path={selection.path}
      data={data}
      loading={loading}
      error={error}
      unavailable={unavailable}
      sessionError={null}
      actionsRef={null}
      onSelect={selection.select}
      onRefresh={refetch}
    />
  );
}

export function ProjectWorkbench(props: ProjectWorkbenchProps) {
  const { t } = useTranslation(['projects', 'chat']);
  const layout = useWorkspaceLayout();
  const localSelection = useWorktreeSelection(props.worktreeSelection ? undefined : props.projectId);
  const worktreeSelection = props.worktreeSelection ?? localSelection;
  const workspaceId = props.workspaceId === undefined ? props.projectId : props.workspaceId;
  const [sessionsHostRef, sessionsHost] = usePortalHost<HTMLDivElement>();
  const [sessionToolbarHostRef, sessionToolbarHost] = usePortalHost<HTMLDivElement>();
  const [databaseHostRef, databaseHost] = usePortalHost<HTMLDivElement>();
  const [gitHostRef, gitHost] = usePortalHost<HTMLDivElement>();
  const [apiLeftHostRef, apiLeftHost] = usePortalHost<HTMLDivElement>();
  const [apiRightHostRef, apiRightHost] = usePortalHost<HTMLDivElement>();
  const [apiLeftOpen, setApiLeftOpen] = useState(true);
  const [apiRightOpen, setApiRightOpen] = useState(true);
  const [sessionRightPanelHostRef, sessionRightPanelHost] = usePortalHost<HTMLDivElement>();
  const [sessionRightRailHostRef, sessionRightRailHost] = usePortalHost<HTMLDivElement>();
  const [sessionState, setSessionState] = useState({ hasSession: !!props.initialSessionId, rightPanelOpen: false });
  const sessionsMode = layout.primarySurface === 'sessions';
  const apiMode = layout.primarySurface === 'api';
  const editorMode = layout.primarySurface === 'editor';
  const handleSessionStateChange = useCallback((next: { hasSession: boolean; rightPanelOpen: boolean }) => {
    setSessionState((current) =>
      current.hasSession === next.hasSession && current.rightPanelOpen === next.rightPanelOpen ? current : next,
    );
  }, []);
  const handleSessionSelected = useCallback(() => {
    useWorkspaceLayout.getState().setPrimarySurface('sessions');
  }, []);
  const handleToggleLeft = useCallback((id: string) => {
    const state = useWorkspaceLayout.getState();
    if (state.primarySurface !== 'editor' || state.activeLeft !== id) {
      state.setPrimarySurface('editor');
      state.setActiveLeft(id);
      return;
    }
    state.toggleLeft(id);
  }, []);
  const handleWorkspaceSelect = useCallback((id: string) => {
    if (id === 'api') {
      setApiLeftOpen(true);
      setApiRightOpen(true);
    }
    useWorkspaceLayout.getState().setPrimarySurface(id);
  }, []);
  const closeApiLeft = useCallback(() => setApiLeftOpen(false), []);
  const closeApiRight = useCallback(() => setApiRightOpen(false), []);
  const apiWorkbenchSlots = useMemo<ApiClientWorkbenchSlots>(() => ({
    leftHost: apiLeftHost,
    rightHost: apiRightHost,
    onCloseLeft: closeApiLeft,
    onCloseRight: closeApiRight,
  }), [apiLeftHost, apiRightHost, closeApiLeft, closeApiRight]);
  const sessionWorkbenchSlots = useMemo<AgentChatWorkbenchSlots>(() => ({
    toolbarHost: sessionToolbarHost,
    sessionsHost,
    rightPanelHost: sessionRightPanelHost,
    rightRailHost: sessionRightRailHost,
    worktreeSelection,
    onSessionStateChange: handleSessionStateChange,
    onSessionSelected: handleSessionSelected,
  }), [handleSessionSelected, handleSessionStateChange, sessionRightPanelHost, sessionRightRailHost, sessionsHost, sessionToolbarHost, worktreeSelection]);
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
  const codeLeftKnown =
    layout.activeLeft === 'files' ||
    layout.activeLeft === 'databases' ||
    layout.activeLeft === 'git' ||
    !!activeLeftPlugin;
  const codeRightKnown =
    layout.activeRight === 'chat' ||
    layout.activeRight === 'memory' ||
    !!activeRightPlugin;
  const bottomKnown = !!layout.activeBottom && (
    BOTTOM_BUILTIN_TAB_IDS.has(layout.activeBottom) ||
    bottomPlugins.some((window) => window.id === layout.activeBottom)
  );

  useEffect(() => {
    if (layout.activeLeft && !codeLeftKnown) layout.setActiveLeft(null);
  }, [codeLeftKnown, layout.activeLeft, layout.setActiveLeft]);
  useEffect(() => {
    if (layout.activeRight && !codeRightKnown) layout.setActiveRight(null);
  }, [codeRightKnown, layout.activeRight, layout.setActiveRight]);
  useEffect(() => {
    if (layout.activeBottom && !bottomKnown) layout.setActiveBottom(null);
  }, [bottomKnown, layout.activeBottom, layout.setActiveBottom]);
  useEffect(() => {
    if (workspaceId != null && layout.primarySurface === 'preview' && !props.previewEnabled) {
      layout.setPrimarySurface('editor');
    }
  }, [layout.primarySurface, layout.setPrimarySurface, props.previewEnabled, workspaceId]);
  useEffect(() => {
    // v2/deep-link compatibility: Database is now a left tool window whose
    // objects open in the editor, never a dedicated primary surface.
    if (layout.primarySurface !== 'databases') return;
    layout.setPrimarySurface('editor');
    layout.setActiveLeft('databases');
  }, [layout.primarySurface, layout.setActiveLeft, layout.setPrimarySurface]);
  const renderLeft = () => {
    if (sessionsMode) {
      return <div key="sessions" ref={sessionsHostRef} className="h-full min-h-0 overflow-hidden" />;
    }
    if (apiMode) {
      return <div key="api-navigation" ref={apiLeftHostRef} className="h-full min-h-0 overflow-hidden" />;
    }
    if (!editorMode) return null;
    if (layout.activeLeft === 'files') {
      return workspaceId != null && (
        <FileTreeView
          key={workspaceId}
          projectId={workspaceId}
          active
          activePath={props.activeFilePath}
          projectRoot={props.projectRoot}
          onOpen={props.onOpenFile}
          onClose={() => layout.setActiveLeft(null)}
        />
      );
    }
    if (layout.activeLeft === 'git') {
      return <div key="git" ref={gitHostRef} className="h-full min-h-0 overflow-hidden" />;
    }
    if (layout.activeLeft === 'databases') {
      return <div key="databases" ref={databaseHostRef} className="h-full min-h-0 overflow-hidden" />;
    }
    if (activeLeftPlugin && workspaceId != null) {
      return (
        <WebviewWindow
          namespace={activeLeftPlugin.pluginNs}
          title={activeLeftPlugin.title}
          entry={activeLeftPlugin.entry}
          key={workspaceId}
          projectId={workspaceId}
          onClose={() => layout.setActiveLeft(null)}
        />
      );
    }
    return null;
  };

  const renderRight = () => {
    if (sessionsMode) {
      return <div key="session-details" ref={sessionRightPanelHostRef} className="h-full min-h-0 overflow-hidden" />;
    }
    if (apiMode) {
      return <div key="api-inspector" ref={apiRightHostRef} className="h-full min-h-0 overflow-hidden" />;
    }
    if (!editorMode) return null;
    if (layout.activeRight === 'chat' && workspaceId != null) {
      return (
        <EditorChatRail
          key={workspaceId}
          projectId={props.projectId}
          workspaceId={workspaceId}
          worktreePath={worktreeSelection.path}
          mainRoot={props.mainRoot}
          projectName={props.projectName}
          onClose={() => layout.setActiveRight(null)}
        />
      );
    }
    if (layout.activeRight === 'memory') {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <WorkbenchPanelHeader
            title={t('snapshotEditor.tab.memory')}
            icon={Brain}
            onClose={() => layout.setActiveRight(null)}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            <TransientSurface
              tab="memory"
              projectId={props.projectId}
              projectName={props.projectName}
              onOpenFile={props.onOpenFile}
              contribWindows={props.contribWindows}
              builderJson={props.builderJson}
              framework={props.framework}
            />
          </div>
        </div>
      );
    }
    if (activeRightPlugin && workspaceId != null) {
      return (
        <WebviewWindow
          namespace={activeRightPlugin.pluginNs}
          title={activeRightPlugin.title}
          entry={activeRightPlugin.entry}
          key={workspaceId}
          projectId={workspaceId}
          onClose={() => layout.setActiveRight(null)}
        />
      );
    }
    return null;
  };

  const leftOpen = sessionsMode
    || (apiMode && apiLeftOpen)
    || (editorMode && !!layout.activeLeft && codeLeftKnown);
  const rightOpen = sessionsMode
    ? sessionState.hasSession && sessionState.rightPanelOpen
    : apiMode
      ? apiRightOpen
      : editorMode && !!layout.activeRight && codeRightKnown;

  return (
    <WorkbenchShell>
      <DatabaseToolWindow
        key={props.projectId}
        projectId={props.projectId}
        workspaceId={workspaceId}
        projectName={props.projectName}
        host={databaseHost}
      />
      {workspaceId != null && (
        <GitWindow
          key={`git-${workspaceId}`}
          projectId={workspaceId}
          host={gitHost}
          active={editorMode && layout.activeLeft === 'git'}
          onClose={() => layout.setActiveLeft(null)}
        />
      )}
      <div className="flex min-h-0 flex-1">
        <ProjectRail
          projectId={props.projectId}
          activeTool={editorMode ? layout.activeLeft : null}
          activeSurface={layout.primarySurface}
          onToggle={handleToggleLeft}
          onSelectSurface={handleWorkspaceSelect}
          previewEnabled={props.previewEnabled}
          bottomOpen={layout.activeBottom !== null}
          onToggleBottom={() => {
            useWorkspaceLayout.getState().toggleBottom('terminal');
          }}
          pluginTabs={leftPlugins.map(pluginTab)}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-1.5">
          {sessionsMode
            ? <div ref={sessionToolbarHostRef} className="shrink-0" />
            : <ProjectCheckoutBar projectId={props.projectId} selection={worktreeSelection} />}
          {workspaceId == null && (
            <div className="shrink-0 px-2 text-xs text-muted-foreground" role={props.workspaceError ? 'alert' : 'status'}>
              {props.workspaceError ?? t('chat:worktrees.resolving')}
            </div>
          )}
          <PanelGroup direction="vertical" autoSaveId={`mcp-workbench-vertical-${props.projectId}`}>
            <Panel id="workbench-main" order={1} minSize={28} className="min-h-0">
              <PanelGroup
                direction="horizontal"
                autoSaveId={`mcp-workbench-horizontal-${props.projectId}-${layout.primarySurface}`}
              >
                {leftOpen && (
                  <>
                    <Panel id="left-dock" order={1} defaultSize={20} minSize={12} maxSize={38} className="min-w-0">
                      <WorkbenchSurface className="h-full">{renderLeft()}</WorkbenchSurface>
                    </Panel>
                    <WorkbenchResizeHandle direction="horizontal" />
                  </>
                )}
                <Panel id="primary" order={2} minSize={34} className="min-w-0">
                  <WorkbenchSurface className="h-full">
                    <ProjectPrimarySurface
                      surface={layout.primarySurface}
                      projectId={props.projectId}
                      workspaceId={workspaceId}
                      worktreePath={worktreeSelection.path}
                      projectName={props.projectName}
                      onOpenFile={props.onOpenFile}
                      initialSessionId={props.initialSessionId}
                      contribWindows={props.contribWindows}
                      builderJson={props.builderJson}
                      previewEnabled={props.previewEnabled}
                      framework={props.framework}
                      sessionWorkbenchSlots={sessionWorkbenchSlots}
                      apiWorkbenchSlots={apiWorkbenchSlots}
                    />
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
                      workspaceId={workspaceId}
                      worktreePath={worktreeSelection.path}
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
          sessionState.hasSession && <div ref={sessionRightRailHostRef} className="contents" />
        ) : apiMode ? (
          <ProjectRightRail
            activeTool={apiRightOpen ? API_RIGHT_TOOL.id : null}
            onToggle={() => setApiRightOpen((open) => !open)}
            pluginTabs={[]}
            tabs={[API_RIGHT_TOOL]}
          />
        ) : editorMode ? (
          <ProjectRightRail
            activeTool={layout.activeRight}
            onToggle={layout.toggleRight}
            pluginTabs={rightPlugins.map(pluginTab)}
          />
        ) : null}
      </div>
      {workspaceId != null && <StatusBar key={`status-${workspaceId}`} projectId={workspaceId} projectName={props.projectName} />}
    </WorkbenchShell>
  );
}
