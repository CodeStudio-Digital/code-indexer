import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CompanyBottomPanel, type CompanyBottomTab } from './CompanyBottomPanel.js';
import { useSandboxStatus } from '../builder/useSandboxStatus.js';
import { Panel, PanelGroup } from 'react-resizable-panels';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useApi } from '../../hooks/useApi.js';
import { useCompanyStream } from '../../hooks/useCompanyStream.js';
import { useCompanySiblings } from '../../hooks/useCompanySiblings.js';
import { useProviders } from '../../hooks/useProviders.js';
import { providerSupportsThinking, resolveReasoningLevels } from '../chat/composer/provider-caps.js';
import type { AgentAttachment } from '../../hooks/agent-stream/types.js';
import type { MasterPrompt } from '@mcp/company/types.js';
import { AgentSessionModal } from './AgentSessionModal.js';
import { MasterComposer } from './MasterComposer.js';
import { FrontTabsBar } from './FrontTabsBar.js';
import { ResetSessionDialog } from './ResetSessionDialog.js';
import { ReestablishMasterDialog } from './ReestablishMasterDialog.js';
import type { RoleConfig, SkillDef } from './RoleEditModal.js';
import { CompanyStatusBar } from './session-view/CompanyStatusBar.js';
import { ZoneLayout } from './zones/ZoneLayout.js';
import { DEFAULT_TAB_FOR_ZONE, type Zone } from './zones/types.js';
import { buildAgentsUrl, parseAgentsParams } from './routing.js';
import { AgentsSidebar } from './session-view/AgentsSidebar.js';
import { SessionHeader } from './session-view/SessionHeader.js';
import { SessionBanners } from './session-view/SessionBanners.js';
import { RoleDialog } from './session-view/RoleDialog.js';
import { parseConfig } from './session-view/types.js';
import { mergeBoardMessages, mergeSubordinates } from './session-view/merge-live-persisted.js';
import { SidebarRail, type SidePanel } from './preview-sidebar/SidebarRail.js';
import { SidebarPanels } from './preview-sidebar/SidebarPanels.js';
import CompanyDbConnectionsPanel from './CompanyDbConnectionsPanel.js';
import { DatabaseToolWindow } from '../db-client/DatabaseToolWindow.js';
import { useContributions, hydrateContributions } from '../../state/contribution-registry.js';
import type { NotificationSourceContext } from '../notifications/index.js';
import type {
  AvailableProject,
  PersistedAgentRun,
  SessionProject,
} from './session-view/types.js';
import { WorkbenchResizeHandle, WorkbenchSurface } from '../../components/workbench/index.js';
import type { CompanySessionWorkbenchSlots } from './company-workbench-slots.js';

interface CompanySessionViewProps {
  sessionId: string;
  sessionName: string;
  sessionStatus: string;
  /**
   * Outer-app sessions-list sidebar toggle (owned by `AgentsTab`).
   * When provided, `SessionHeader` renders a button that controls it
   * — letting us merge the AgentsTab top bar into SessionHeader and
   * show only one bar.
   */
  sessionsListOpen?: boolean;
  onToggleSessionsList?: () => void;
  workbenchSlots?: CompanySessionWorkbenchSlots;
  runtimeKind?: 'company' | 'app_studio';
  appSessionId?: string | null;
}

interface SessionFullData {
  session: {
    id: string;
    name: string;
    status: string;
    config_json: string;
    template_id: number | null;
    last_user_message?: string | null;
    /** P15c — set when boot recovery flipped this session to `paused`. */
    recovered_at?: string | null;
    recovered_reason?: string | null;
  };
  projects: SessionProject[];
  agentRuns: PersistedAgentRun[];
  recentBoard: Array<{
    id: string;
    seq: number;
    author_role: string;
    agent_run_id: string | null;
    kind: string;
    content: string;
    mentions: string[];
    created_at: string;
  }>;
  /**
   * Pending + recently-resolved master prompts (ask_user / submit_plan).
   * Used to rehydrate `stream.masterPrompts` on first load so a tab that
   * opens with the master already blocked on a question shows the card
   * immediately (no SSE event needed). Backed by the
   * `getCompanySessionFull` route's `masterPrompts` field.
   */
  masterPrompts?: MasterPrompt[];
}

export function CompanySessionView({
  sessionId,
  sessionName,
  sessionStatus,
  sessionsListOpen,
  onToggleSessionsList,
  workbenchSlots,
  runtimeKind = 'company',
  appSessionId = null,
}: CompanySessionViewProps) {
  const { t } = useTranslation('agents');
  const contribWindows = useContributions((s) => s.toolWindows);

  // Multi-front (migration 067): the URL identifies the ROOT session
  // (parent of the tab tree). The active tab can be the parent itself
  // ("Main") or any non-archived child. `useCompanyStream` is mounted
  // on the active id, so switching tabs gives us a clean stream of
  // that sub-session's board / agents / prompts.
  const siblings = useCompanySiblings(sessionId);
  const activeSessionId = siblings.activeSessionId ?? sessionId;
  // URL drives zone + tab + active front. `parseAgentsParams` falls back
  // to safe defaults when the URL is incomplete or malformed.
  const routeParams = useParams<{
    rootId?: string;
    frontId?: string;
    zone?: string;
    tab?: string;
  }>();
  const navigate = useNavigate();
  const route = parseAgentsParams(routeParams, sessionId);
  const zone: Zone = route?.zone ?? 'work';
  const tab = route?.tab ?? DEFAULT_TAB_FOR_ZONE.work;
  const activeFrontId = route?.frontId ?? sessionId;
  const notificationContext = useMemo<NotificationSourceContext>(() => {
    const baseTarget = {
      kind: 'company' as const,
      scopeId: sessionId,
      sessionId: activeSessionId,
      label: sessionName,
    };
    return {
      target: {
        ...baseTarget,
        route: buildAgentsUrl(sessionId, activeFrontId, 'work', 'board'),
      },
      pipelineTarget: {
        ...baseTarget,
        route: buildAgentsUrl(sessionId, activeFrontId, 'work', 'pipelines'),
      },
    };
  }, [activeFrontId, activeSessionId, sessionId, sessionName]);
  const stream = useCompanyStream(activeSessionId, notificationContext);
  const { data: sessionData, refetch } = useApi<SessionFullData>(
    `/company/sessions/${activeSessionId}`,
  );

  const handleZoneTabChange = (nextZone: Zone, nextTab: string) => {
    navigate(buildAgentsUrl(sessionId, activeFrontId, nextZone, nextTab));
  };

  // Phase H — Reestabelecer Master. The dialog (mounted at the bottom of
  // this view, like ResetSessionDialog) handles the API call + error
  // surface. We just open it here and react to onSpawned by navigating
  // to the new recovery session's front.
  const [reestablishMasterOpen, setReestablishMasterOpen] = useState(false);
  const handleReestablishSpawned = useCallback(
    ({ masterCoderSessionId: _id }: { masterCoderSessionId: string }) => {
      // The new master is the master of THIS company session — its tab is
      // the Main tab (frontId = 'main' / company sessionId). Navigate
      // there so the user lands on the new master view; the SSE stream
      // for that session id picks up the newly-running master.
      navigate(buildAgentsUrl(sessionId, 'main', 'work', 'chat'));
    },
    [sessionId, navigate],
  );

  // Right-rail panel selection: `null` collapses the panel and shows
  // only the icon rail. The rail itself is always mounted; Inbox / Env /
  // Databases / Company-Config work for every session. We default to
  // `company-config` so the first visit shows roles + projects + agents
  // in context — same affordance the old left-rail AgentsSidebar gave
  // for free, now on the right.
  const [sidePanel, setSidePanel] = useState<SidePanel | null>('company-config');
  const DATABASE_PROJECT_KEY = `mcp-ide:agents.databaseProject.${sessionId}`;
  const [selectedDatabaseProjectId, setSelectedDatabaseProjectId] = useState<number | null>(() => {
    if (typeof window === 'undefined') return null;
    const stored = Number(window.localStorage.getItem(DATABASE_PROJECT_KEY));
    return Number.isInteger(stored) && stored > 0 ? stored : null;
  });
  const [databaseNavigatorHost, setDatabaseNavigatorHost] = useState<HTMLDivElement | null>(null);
  const [databaseEditorHost, setDatabaseEditorHost] = useState<HTMLDivElement | null>(null);
  // Bottom panel — workspace-style, resizable via
  // `react-resizable-panels` (which persists the size on its own via
  // `autoSaveId`). Its active tab is also the open/closed state, matching
  // ProjectWorkbench's `activeBottom` contract. The legacy terminal flag
  // remains a migration source for layouts saved before Runners moved here.
  const TERMINAL_OPEN_KEY = `mcp-ide:agents.terminalOpen.${sessionId}`;
  const BOTTOM_TAB_KEY = `mcp-ide:agents.bottomTab.${sessionId}`;
  const [activeBottom, setActiveBottom] = useState<CompanyBottomTab | null>(() => {
    if (typeof window === 'undefined') return null;
    const stored = window.localStorage.getItem(BOTTOM_TAB_KEY);
    if (stored === 'terminal' || stored === 'runners') return stored;
    return window.localStorage.getItem(TERMINAL_OPEN_KEY) === '1' ? 'terminal' : null;
  });
  // Sandbox status — drives the "Sandbox" target option in the
  // terminal spawn menu. Hook is cached per sessionId so cost is
  // amortised even when the terminal stays closed.
  const sandboxStatus = useSandboxStatus(sessionId);
  const hasSandboxForTerminal = !!sandboxStatus.data?.containerId;

  const persistBottom = useCallback((next: CompanyBottomTab | null) => {
    setActiveBottom(next);
    try {
      if (next) window.localStorage.setItem(BOTTOM_TAB_KEY, next);
      else window.localStorage.removeItem(BOTTOM_TAB_KEY);
      // Keep writing the old boolean during the transition so older builds
      // still understand whether a company bottom panel was open.
      window.localStorage.setItem(TERMINAL_OPEN_KEY, next ? '1' : '0');
    } catch {
      /* localStorage disabled — silent */
    }
  }, [BOTTOM_TAB_KEY, TERMINAL_OPEN_KEY]);

  const toggleBottom = useCallback((requested: CompanyBottomTab) => {
    setActiveBottom((current) => {
      const next = current === requested ? null : requested;
      try {
        if (next) window.localStorage.setItem(BOTTOM_TAB_KEY, next);
        else window.localStorage.removeItem(BOTTOM_TAB_KEY);
        window.localStorage.setItem(TERMINAL_OPEN_KEY, next ? '1' : '0');
      } catch {
        /* localStorage disabled — silent */
      }
      return next;
    });
  }, [BOTTOM_TAB_KEY, TERMINAL_OPEN_KEY]);

  // Old bookmarks used `/build/terminal` and `/build/runners` because both
  // tools once replaced the central surface. Open the corresponding bottom
  // tab and normalize the center back to the regular Build surface.
  useEffect(() => {
    if (runtimeKind === 'app_studio') return;
    const legacyBottom = routeParams.zone === 'build' &&
      (routeParams.tab === 'terminal' || routeParams.tab === 'runners')
      ? routeParams.tab
      : null;
    if (!legacyBottom) return;
    persistBottom(legacyBottom);
    navigate(
      buildAgentsUrl(sessionId, activeFrontId, 'build', DEFAULT_TAB_FOR_ZONE.build),
      { replace: true },
    );
  }, [activeFrontId, navigate, persistBottom, routeParams.tab, routeParams.zone, runtimeKind, sessionId]);
  const [modalSession, setModalSession] = useState<{
    coderSessionId: string;
    role: string;
    status: string;
  } | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [roleDialog, setRoleDialog] = useState<{ draft: RoleConfig; editIdx?: number } | null>(null);

  // Reference data for the sidebar and modals.
  const { data: allProjects } = useApi<AvailableProject[]>('/projects');
  const { data: skillsList } = useApi<{ skills: SkillDef[] }>('/admin/skills');
  const { providerOptions, getModelsForProvider, getDefaultModel } = useProviders();

  // Hydrate plugin UI contributions so contributed tool windows show up
  // as extra right-drawer panels in this company session view.
  useEffect(() => {
    void hydrateContributions();
  }, []);

  const selectDatabaseProject = useCallback((projectId: number) => {
    setSelectedDatabaseProjectId(projectId);
    try {
      window.localStorage.setItem(DATABASE_PROJECT_KEY, String(projectId));
    } catch {
      /* localStorage disabled — the in-memory selection still works */
    }
  }, [DATABASE_PROJECT_KEY]);

  useEffect(() => {
    if (selectedDatabaseProjectId == null || !sessionData?.projects) return;
    if (sessionData.projects.some((project) => project.project_id === selectedDatabaseProjectId)) return;
    setSelectedDatabaseProjectId(null);
    try {
      window.localStorage.removeItem(DATABASE_PROJECT_KEY);
    } catch {
      /* localStorage disabled */
    }
  }, [DATABASE_PROJECT_KEY, selectedDatabaseProjectId, sessionData?.projects]);

  // Ctrl+J toggles the Terminal tab in the bottom panel — same shortcut as the
  // Workspace. We listen at the window level so the binding works
  // regardless of which tab inside ZoneLayout has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (runtimeKind === 'app_studio') return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === 'j') {
        e.preventDefault();
        toggleBottom('terminal');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runtimeKind, toggleBottom]);

  // Reset stream state when the active sub-session changes (tab switch
  // or explicit session change). Each sub-session has its own metaBus
  // and own state — re-mounting the hook on a fresh id does the rest.
  useEffect(() => {
    stream.reset();
  }, [activeSessionId]);

  // Hydrate pending master prompts from the initial fetch — a tab that
  // opens while the master is already blocked on `ask_user` would
  // otherwise show nothing until the user pokes the session.
  useEffect(() => {
    if (sessionData?.masterPrompts) {
      stream.hydrateMasterPrompts(sessionData.masterPrompts);
    }
  }, [sessionData?.masterPrompts]);

  // On mount, attempt ONE reattach if the session is already running.
  // We intentionally do NOT put stream.connected in the dep array —
  // it would create an infinite loop (reattach → 404 → connected=false
  // → effect fires → …).
  const reattachAttemptedRef = useRef(false);
  useEffect(() => {
    reattachAttemptedRef.current = false;
    if ((sessionStatus === 'running' || sessionStatus === 'paused') && !stream.connected) {
      reattachAttemptedRef.current = true;
      stream.reattach();
    }
    return () => {
      reattachAttemptedRef.current = false;
    };
  }, [sessionId, sessionStatus]);

  // Merge persisted agent runs with the live subordinate stream so agents
  // from a recovered session / prior turn stay listed (and clickable) even
  // when nothing is currently streaming for them. Live state wins; the
  // persisted `coderSessionId` is preserved when the live seed lacks it.
  const subordinates = useMemo(
    () => mergeSubordinates(sessionData?.agentRuns ?? [], stream.subordinateStates),
    [sessionData?.agentRuns, stream.subordinateStates],
  );
  const config = sessionData ? parseConfig(sessionData.session.config_json) : null;
  const masterProvider = (config?.master_provider as string | undefined) ?? null;
  const masterModel = (config?.master_model as string | undefined) ?? null;
  const masterSupportsThinking = providerSupportsThinking(masterProvider, providerOptions, masterModel);
  const masterReasoningLevels = resolveReasoningLevels(masterProvider, providerOptions, masterModel);
  const masterReasoningEffort = (config?.master_reasoning_effort as string | undefined) ?? null;
  const handleMasterEffortChange = async (next: string | null) => {
    try {
      await fetch(`/api/company/sessions/${activeSessionId}/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ master_reasoning_effort: next }),
      });
      refetch();
    } catch {
      /* optimistic — server is source of truth on next refetch */
    }
  };
  const builderMode = !!(
    config &&
    typeof config === 'object' &&
    'builder' in config &&
    (config as { builder?: unknown }).builder
  );

  const togglePanel = (panel: SidePanel) => {
    setSidePanel((cur) => (cur === panel ? null : panel));
  };

  const visibleSidePanel = runtimeKind === 'app_studio' && sidePanel !== 'company-config'
    ? null
    : sidePanel;
  const databaseMode = runtimeKind === 'company' && visibleSidePanel === 'databases';
  const selectedDatabaseProject = (sessionData?.projects ?? []).find(
    (project) => project.project_id === selectedDatabaseProjectId,
  ) ?? null;
  const handleWorkbenchZoneTabChange = (nextZone: Zone, nextTab: string) => {
    // The database editor temporarily owns the Company center. A selection in
    // the left activity rail must reveal the requested surface immediately;
    // otherwise the URL changes behind an unchanged database canvas.
    setSidePanel((current) => current === 'databases' ? null : current);
    handleZoneTabChange(nextZone, nextTab);
  };

  // Session already has a run if status is not idle/draft — use sendMessage, not start.
  const sessionAlreadyRan =
    sessionStatus === 'running' ||
    sessionStatus === 'completed' ||
    sessionStatus === 'paused' ||
    sessionStatus === 'error';

  async function handleSend(
    text: string,
    attachments: AgentAttachment[],
    opts?: { thinking?: boolean },
  ) {
    if (!stream.connected && (sessionAlreadyRan || stream.started)) {
      await stream.resume(text, attachments, opts);
      refetch();
    } else if (!stream.started && !sessionAlreadyRan) {
      await stream.start(text, attachments, opts);
      refetch();
    } else {
      await stream.sendMessage(text, attachments, opts);
    }
  }

  function openAgentRun(agentRunId: string, role: string, status: string) {
    // Resolve the coder session id from the merged live agent first (a
    // freshly-spawned subordinate carries it via the spawn `agent_status`
    // before the REST snapshot is refreshed), then the persisted run, then
    // the master. Without this, a live agent's row click was a no-op.
    const merged = subordinates.find((s) => s.agentRunId === agentRunId);
    const coderSessionId =
      merged?.coderSessionId ??
      sessionData?.agentRuns.find((r) => r.id === agentRunId)?.coder_session_id ??
      (stream.masterState?.agentRunId === agentRunId
        ? stream.masterState.coderSessionId
        : undefined);
    if (coderSessionId) {
      setModalSession({ coderSessionId, role, status });
    }
  }

  function openPersistedRun(coderSessionId: string, role: string, status: string) {
    setModalSession({ coderSessionId, role, status });
  }

  // Merge board from persisted (initial REST fetch) + live stream, deduped
  // by id. Rendering either source exclusively dropped history the instant
  // the first live `board_entry` arrived; the union keeps the full feed.
  const boardMessages = useMemo(
    () =>
      mergeBoardMessages(
        (sessionData?.recentBoard ?? []).map((b) => ({
          id: b.id,
          seq: b.seq,
          author_role: b.author_role,
          agent_run_id: b.agent_run_id,
          kind: b.kind,
          content: b.content,
          mentions: b.mentions,
          created_at: b.created_at,
        })),
        stream.boardMessages,
      ),
    [sessionData?.recentBoard, stream.boardMessages],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--workbench-canvas)]">
      {runtimeKind === 'company' && selectedDatabaseProject && (
        <DatabaseToolWindow
          key={`company-database-${selectedDatabaseProject.project_id}`}
          projectId={selectedDatabaseProject.project_id}
          projectName={selectedDatabaseProject.label?.trim() || selectedDatabaseProject.project_name}
          host={databaseMode ? databaseNavigatorHost : null}
          editorHost={databaseMode ? databaseEditorHost : null}
          embeddedEditor
        />
      )}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Same hierarchy as ProjectWorkbench: the vertical split owns the
            whole workbench, so the bottom dock spans catalog + primary + right dock.
            The fixed-width activity rail remains outside every resizable
            panel and every surface gets the shared 6px workbench gutter. */}
        <div className="min-w-0 flex-1 p-1.5">
          <PanelGroup direction="vertical" autoSaveId={`mcp-agents-vert-${sessionId}`}>
            <Panel id="company-main" order={1} minSize={28} className="min-h-0">
              <PanelGroup direction="horizontal" autoSaveId={`mcp-agents-horiz-${sessionId}`}>
                {runtimeKind === 'company' && workbenchSlots?.catalog.open && (
                  <>
                    <Panel
                      id="company-catalog-dock"
                      order={1}
                      defaultSize={22}
                      minSize={16}
                      maxSize={34}
                      collapsible
                      collapsedSize={0}
                      onCollapse={() => workbenchSlots.catalog.onOpenChange(false)}
                      onExpand={() => workbenchSlots.catalog.onOpenChange(true)}
                      className="min-w-0"
                    >
                      {workbenchSlots.catalogPanel}
                    </Panel>
                    <WorkbenchResizeHandle direction="horizontal" />
                  </>
                )}

                <Panel id="company-primary" order={2} minSize={34} className="min-w-0">
                  <WorkbenchSurface className="flex h-full flex-col bg-[var(--workbench-canvas)]">
                    {/* Session context belongs to the primary surface. Keeping
                        it here aligns it with every tool-window header instead
                        of creating a full-width band above the right dock and
                        activity rail. */}
                    <SessionHeader
                      sessionName={sessionName}
                      sessionStatus={sessionStatus}
                      reportedStatus={sessionData?.session.status}
                      stream={stream}
                      sessionsListOpen={sessionsListOpen}
                      onToggleSessionsList={onToggleSessionsList}
                      recoveredAt={sessionData?.session.recovered_at ?? null}
                      recoveredReason={sessionData?.session.recovered_reason ?? null}
                      allowAbort={runtimeKind === 'company'}
                      onResetClick={runtimeKind === 'company' ? () => setResetDialogOpen(true) : undefined}
                      onReestablishMasterClick={runtimeKind === 'company' ? () => setReestablishMasterOpen(true) : undefined}
                    />
                    <SessionBanners
                      stream={stream}
                      sessionId={activeSessionId}
                      readOnly={runtimeKind === 'app_studio'}
                    />
                    {runtimeKind === 'app_studio' && appSessionId != null && (
                      <div className="flex h-8 items-center gap-2 border-b border-violet-500/20 bg-violet-500/5 px-3 text-[10px] text-muted-foreground">
                        <span className="font-medium text-violet-300">{t('company.appTeam.title')}</span>
                        <span>{t('company.appTeam.description')}</span>
                        <button
                          type="button"
                          onClick={() => navigate(`/apps/${appSessionId}`)}
                          className="ml-auto text-violet-300 hover:underline"
                        >
                          {t('company.openAppWorkflow')}
                        </button>
                      </div>
                    )}

                    {/* Front tabs — visible across every zone so the user always
                        has a way to switch between Main and child fronts. */}
                    {runtimeKind === 'company' && siblings.parent && (
                      <FrontTabsBar
                        parent={siblings.parent}
                        children={siblings.children}
                        activeSessionId={siblings.activeSessionId}
                        onSelect={siblings.setActiveSessionId}
                        onCreate={siblings.createChild}
                        onArchive={siblings.archiveChild}
                        onRename={siblings.renameChild}
                      />
                    )}

                    {/* Company content and the embedded database editor coexist.
                        The inactive surface is hidden, never unmounted, so board
                        scroll/composer state and database tabs survive toggles. */}
                    <div className="relative flex min-h-0 flex-1 overflow-hidden">
                      <div
                        aria-hidden={databaseMode}
                        className={`absolute inset-0 flex min-h-0 ${databaseMode ? 'invisible pointer-events-none' : ''}`}
                      >
                        <ZoneLayout
                          sessionId={sessionId}
                          sessionName={sessionName}
                          zone={zone}
                          tab={tab}
                          onZoneTabChange={handleWorkbenchZoneTabChange}
                          stream={stream}
                          boardMessages={boardMessages}
                          bottomOpen={activeBottom !== null}
                          onToggleBottom={() => toggleBottom('terminal')}
                          workbenchSlots={workbenchSlots}
                          runtimeKind={runtimeKind}
                          composer={runtimeKind === 'company' ? (
                            <MasterComposer
                              sessionId={activeSessionId}
                              onSend={handleSend}
                              placeholder={
                                !stream.started && !sessionAlreadyRan
                                  ? t('company.inputPlaceholder')
                                  : t('company.inputPlaceholderMaster')
                              }
                              supportsThinking={masterSupportsThinking}
                              reasoningEffort={masterReasoningEffort}
                              setReasoningEffort={handleMasterEffortChange}
                              reasoningLevels={masterReasoningLevels}
                            />
                          ) : undefined}
                        />
                      </div>
                      {databaseMode && (
                        <div ref={setDatabaseEditorHost} className="absolute inset-0 overflow-hidden" />
                      )}
                    </div>
                  </WorkbenchSurface>
                </Panel>

                {/* Right dock is a sibling of the primary surface, exactly like
                    ProjectWorkbench. The rail that controls it stays outside
                    the padded/resizable workbench below. */}
                {visibleSidePanel !== null && (
                  <>
                    <WorkbenchResizeHandle direction="horizontal" />
                    <Panel id="company-right-dock" order={3} defaultSize={26} minSize={20} maxSize={46} className="min-w-0">
                      <WorkbenchSurface className="flex h-full flex-col bg-[var(--workbench-surface)]">
                        <SidebarPanels
                          sessionId={sessionId}
                          active={visibleSidePanel}
                          databaseSlot={
                            <CompanyDbConnectionsPanel
                              projects={sessionData?.projects ?? []}
                              selectedProjectId={selectedDatabaseProjectId}
                              onSelectProject={selectDatabaseProject}
                              onHostChange={setDatabaseNavigatorHost}
                            />
                          }
                          companyConfigSlot={
                            <AgentsSidebar
                              sessionId={sessionId}
                              open={true}
                              config={config}
                              projects={sessionData?.projects ?? []}
                              allProjects={allProjects ?? null}
                              persistedAgentRuns={sessionData?.agentRuns ?? []}
                              subordinates={subordinates}
                              stream={stream}
                              providerOptions={providerOptions}
                              getModelsForProvider={getModelsForProvider}
                              getDefaultModel={getDefaultModel}
                              refetch={refetch}
                              onOpenAgentRun={openAgentRun}
                              onOpenPersistedRun={openPersistedRun}
                              onOpenRoleDialog={(args) => setRoleDialog(args)}
                              readOnly={runtimeKind === 'app_studio'}
                            />
                          }
                          pluginWindows={contribWindows}
                          readOnly={runtimeKind === 'app_studio'}
                        />
                      </WorkbenchSurface>
                    </Panel>
                  </>
                )}
              </PanelGroup>
            </Panel>

            {/* Bottom dock spans the complete resizable workbench (catalog +
                primary + right dock) rather than being nested inside the
                conversation. The fixed activity rails remain outside it. */}
            {runtimeKind === 'company' && activeBottom && (
              <>
                <WorkbenchResizeHandle direction="vertical" />
                <Panel id="company-bottom-dock" order={2} defaultSize={28} minSize={12} maxSize={62} className="min-h-0">
                  <WorkbenchSurface className="h-full bg-[var(--workbench-surface)]">
                    <CompanyBottomPanel
                      companySessionId={sessionId}
                      projects={sessionData?.projects ?? []}
                      hasSandbox={hasSandboxForTerminal}
                      activeTab={activeBottom}
                      onSelectTab={persistBottom}
                      onCollapse={() => persistBottom(null)}
                      onClose={() => persistBottom(null)}
                    />
                  </WorkbenchSurface>
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>
        <SidebarRail
          active={visibleSidePanel}
          onToggle={togglePanel}
          pluginWindows={contribWindows}
          readOnly={runtimeKind === 'app_studio'}
        />
      </div>

      {/* IDE-style status strip — the very last row of the view, just
          like ProjectView's <StatusBar/>. Spans full width below the
          left sidebar, central column AND right rail/drawer. */}
      <CompanyStatusBar
        started={stream.started}
        masterState={stream.masterState}
        error={stream.error}
        masterAlive={stream.masterAlive}
        pendingMasterInboxCount={stream.pendingMasterInboxCount}
        subordinateCount={subordinates.length}
        activeSubordinateCount={
          subordinates.filter(
            (s) =>
              s.status === 'running' ||
              s.status === 'waiting_plan' ||
              s.status === 'waiting_question' ||
              s.status === 'waiting_tasks',
          ).length
        }
        onWakeMaster={runtimeKind === 'company' ? () => void stream.wakeMaster() : undefined}
        t={t}
      />

      {modalSession && (
        <AgentSessionModal
          coderSessionId={modalSession.coderSessionId}
          role={modalSession.role}
          status={modalSession.status}
          onClose={() => setModalSession(null)}
        />
      )}

      {runtimeKind === 'company' && resetDialogOpen && (
        <ResetSessionDialog
          sessionId={sessionId}
          sessionName={sessionName}
          builderMode={builderMode}
          onClose={() => setResetDialogOpen(false)}
          onResetDone={() => {
            stream.reset();
            refetch();
          }}
        />
      )}

      {runtimeKind === 'company' && reestablishMasterOpen && (
        <ReestablishMasterDialog
          sessionId={sessionId}
          sessionName={sessionName}
          onClose={() => setReestablishMasterOpen(false)}
          onSpawned={handleReestablishSpawned}
        />
      )}

      {runtimeKind === 'company' && roleDialog && config && (
        <RoleDialog
          sessionId={sessionId}
          config={config}
          initialDraft={roleDialog.draft}
          editIdx={roleDialog.editIdx}
          stream={stream}
          skills={skillsList?.skills ?? []}
          providerOptions={providerOptions}
          getModelsForProvider={getModelsForProvider}
          getDefaultModel={getDefaultModel}
          onClose={() => setRoleDialog(null)}
          onApplied={() => {
            refetch();
            setRoleDialog(null);
          }}
        />
      )}
    </div>
  );
}
