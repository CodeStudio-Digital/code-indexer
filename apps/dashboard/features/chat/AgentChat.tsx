import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_SESSION_MAX_AUTO_CONTINUES } from '@mcp/session-storage/run-limits.js';
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { IndexingOverlay } from './IndexingOverlay.js';
import { useTranslation } from 'react-i18next';
import { useAgentStream } from '../../hooks/useAgentStream.js';
import { apiDelete, apiPatch, apiPost, useApi } from '../../hooks/useApi.js';
import { deleteChats } from './delete-chats.js';
import { useDeletedSession } from './useDeletedSession.js';
import { useElementWidth } from '../../hooks/useElementWidth.js';
import { useOpenedOnce } from '../../hooks/useOpenedOnce.js';
import { Button } from '../../components/ui/button.js';
import { useConfirm } from '../../components/ui/dialog-provider.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { ChatHeader } from './ChatHeader.js';
import { LiveChatRightRail as ChatRightRail } from './right-panel/ChatRightRail.js';
import { RightPanelHost } from './right-panel/RightPanelHost.js';
import {
  SESSION_INSIGHTS_TAB_EVENT,
  SESSION_INSIGHTS_TAB_STORAGE_KEY,
  type SessionInsightsTab,
} from './right-panel/session-insights-tabs.js';
import { usePluginPanels } from './right-panel/usePluginPanels.js';
import { setDiagramXml, getDiagram } from './right-panel/diagram/diagram-store.js';
import type { RightPanelId } from './right-panel/types.js';
import { Composer, type ComposerHandle } from './composer/Composer.js';
import { levelFromSession, type OutputCapLevel } from './composer/output-cap-levels.js';
import { useMessageQueue, type QueueDeliver, type QueueMode } from './composer/useMessageQueue.js';
import { QueuedMessages } from './composer/QueuedMessages.js';
import { providerSupportsThinking, resolveReasoningLevels } from './composer/provider-caps.js';
import {
  DEFAULT_NEW_EXECUTION_MODE,
  executionModeChangeLocked,
  hydratedReasoningEffort,
  modelCanReason,
  ultraManagesThinking,
} from './execution-mode-state.js';
import { useSessionExecutionMode } from './useSessionExecutionMode.js';
import { isAgentPreset } from './agent-state.js';
import { useSessionAgent } from './useSessionAgent.js';
import { useSessionProvider } from './useSessionProvider.js';
import { ProviderSelectionNotice } from './ProviderSelectionNotice.js';
import { sessionProviderSwitches } from '../../hooks/agent-stream/provider-switch.js';
import { PROVIDERS } from './constants.js';
import { EmptyChatState } from './EmptyChatState.js';
import { LiveMessageList } from './messages/LiveMessageList.js';
import {
  allocateOptimisticMessageId,
  appendOptimisticUserMessage,
  mergeEarlierMessagePage,
  sessionDataForSelection,
} from './messages/session-message-data.js';
import { StuckBanner } from './StuckBanner.js';
import { ApprovalBanner } from './ApprovalBanner.js';
import { NotificationBanner } from './notifications/NotificationBanner.js';
import { useUnreadNotificationCount } from './notifications/session-notifications-store.js';
// Former modal surfaces and the WorkerLog/SessionState panels are now routed
// through `RightPanelHost`; metrics/details/tool stats share Insights. Only
// Snapshots stays as a true Dialog because its diff viewer needs full width.
import { SessionSidebar, type SessionView } from './SessionSidebar.js';
import { SessionWorkspaceBar } from './SessionWorkspaceBar.js';
import { useSessionWorktrees } from './useSessionWorktrees.js';
import { usePortalHost } from '../../hooks/usePortalHost.js';
// Rarely-opened surfaces, each in its own async chunk. They used to sit in the
// chat's eager bundle even though the user has to click something to reach
// them: the snapshots review panel alone pulls ~3.7k lines (file list + diff
// viewer). `useOpenedOnce` keeps the mount-once semantics of a static import,
// so exit animations and in-progress form state behave exactly as before.
const SessionImportDialog = lazy(() =>
  import('./SessionImportDialog.js').then((m) => ({ default: m.SessionImportDialog })),
);
const GlobalNewSessionDialog = lazy(() =>
  import('./global/GlobalNewSessionDialog.js').then((m) => ({ default: m.GlobalNewSessionDialog })),
);
const ManageGlobalProjectsDialog = lazy(() =>
  import('./global/ManageGlobalProjectsDialog.js').then((m) => ({ default: m.ManageGlobalProjectsDialog })),
);
const SnapshotsPanel = lazy(() =>
  import('../snapshots/SnapshotsPanel.js').then((m) => ({ default: m.SnapshotsPanel })),
);
import {
  firstModelValue,
  type SessionLaunchConfig,
} from './SessionLaunchDialog.js';
import { usePinnedTabs } from '../../state/pinned-tabs.js';
import { useActiveSurface } from '../../state/active-surface.js';
import { buildSessionPin } from '../../state/pinned-tabs-describe.js';
import { sessionPinId as makeSessionPinId } from '../../state/pinned-tabs-types.js';
import { fetchSnapshotList } from '../snapshots/api.js';
import { buildSnapshotFileMap, type SnapshotActions } from './messages/snapshot-files-context.js';
import type { SnapshotFileSummary } from '../snapshots/types.js';
import type {
  AgentChatProps,
  CoderSession,
  CoderSessionGroup,
  EarlierMessagePageResult,
  MessagePage,
  PromptHandlers,
  SessionData,
} from './types.js';
import { useAgentChatState } from './useAgentChatState.js';
import { consumePendingAttachments, consumeSelectionPrefix, onStudioSend, usePublishAgentBusy } from '../builder/studio/studio-context-store.js';
import type { AgentAttachment } from '../../hooks/useAgentStream.js';
import type { NotificationSourceContext } from '../notifications/index.js';
import { markRouteEvent } from '../../lib/perf/route-startup-metrics.js';

export default function AgentChat({ projectId, projectName, mode = 'project', initialSessionId, selectionPrefixSessionId, hideAgentPicker, workbenchSlots, preview }: AgentChatProps) {
  const { t } = useTranslation(['chat', 'common', 'projects']);
  const confirm = useConfirm();
  // Global (multi-project) mode: the session list is cross-project (no
  // project_id filter), groups are disabled, and new sessions go through the
  // project multi-select dialog. Default 'project' keeps every existing mount
  // byte-identical.
  const isGlobal = mode === 'global';
  const previewAvailable = !isGlobal && projectId != null && preview != null;
  useEffect(() => {
    markRouteEvent('AgentChat:mounted', { projectId, tab: 'chat', mode });
  }, [mode, projectId]);
  const [view, setView] = useState<SessionView>('active');
  const { data: sessions, refetch: refetchSessions, update: updateSessions } = useApi<CoderSession[]>(
    isGlobal
      ? `/coder/sessions/global?archived=${view === 'archived' ? '1' : '0'}`
      : `/coder/sessions?project_id=${projectId}&archived=${view === 'archived' ? '1' : '0'}`,
  );
  const { data: groups, refetch: refetchGroups } = useApi<CoderSessionGroup[]>(
    // Groups are per-project; disabled in global mode ('' → useApi skips the fetch).
    isGlobal ? '' : `/coder/groups?project_id=${projectId}`,
  );
  useEffect(() => {
    const onSessionsChanged = () => {
      refetchSessions();
      if (!isGlobal) refetchGroups();
    };
    window.addEventListener('coder:sessions-changed', onSessionsChanged);
    return () => window.removeEventListener('coder:sessions-changed', onSessionsChanged);
  }, [refetchSessions, refetchGroups, isGlobal]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessionActionsRef, sessionActionsHost] = usePortalHost<HTMLDivElement>();
  const [sessionCreateError, setSessionCreateError] = useState<string | null>(null);
  // Global mode: which linked project the right-rail file tree is rooted at.
  // Defaults to the selected session's primary; reset when the session changes.
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [provider, setProvider] = useState('zai');
  const [model, setModel] = useState('');

  // Live diagram updates: the draw.io agent's diagram_create/update emits
  // `diagram_changed` over SSE (bridged to a DOM event by handlers.ts). Feed
  // the session-keyed store so the embedded editor renders the new XML, and
  // auto-open the wide Diagram panel the FIRST time per session (subsequent
  // edits update in place without stealing focus).
  const autoOpenedDiagram = useRef<Set<string>>(new Set());
  useEffect(() => {
    const onDiagramChanged = (e: Event): void => {
      const d = (e as CustomEvent).detail as { sessionId?: string; path?: string; xml?: string };
      if (!d || d.sessionId !== selectedId || !d.path || typeof d.xml !== 'string') return;
      setDiagramXml(d.sessionId, d.path, d.xml);
      if (!autoOpenedDiagram.current.has(d.sessionId)) {
        autoOpenedDiagram.current.add(d.sessionId);
        setActiveRightPanelId('diagram');
      }
    };
    window.addEventListener('coder:diagram_changed', onDiagramChanged);
    return () => window.removeEventListener('coder:diagram_changed', onDiagramChanged);
  }, [selectedId]);
  const [maxTurns, setMaxTurns] = useState<number | null>(null);
  const [maxAutoContinues, setMaxAutoContinues] = useState(
    DEFAULT_SESSION_MAX_AUTO_CONTINUES,
  );
  const [fallbackProvider, setFallbackProvider] = useState<string | null>(null);
  const [fallbackModel, setFallbackModel] = useState<string | null>(null);
  const [sessionTemperature, setSessionTemperature] = useState<number | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [planDepth, setPlanDepth] = useState<string | null>(null);
  const [responseLanguage, setResponseLanguage] = useState<string | null>(null);
  const [outputStyle, setOutputStyle] = useState<string | null>(null);
  const [outputCapLevel, setOutputCapLevel] = useState<OutputCapLevel>('economic');
  const [toolPermissionMode, setToolPermissionMode] = useState<'ask' | 'auto' | 'unrestricted'>('auto');
  const [summarizing, setSummarizing] = useState<boolean>(false);
  const composerRef = useRef<ComposerHandle>(null);
  const sessionsPanelRef = useRef<ImperativePanelHandle>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Auto-colapso da barra de sessões por LARGURA real da área de chat (não
  // do viewport): quando o painel de chat aperta (App Studio ~45%, ProjectView
  // com painel direito, janela pequena) a lista fica minúscula. Medimos a área
  // e, em CRUZAMENTOS de faixa (histerese p/ não flapar), colapsamos/expandimos
  // — sem brigar com o toggle manual (que limpa `autoCollapsedRef`).
  const [chatAreaRef, chatAreaWidth] = useElementWidth<HTMLDivElement>();
  const autoCollapsedRef = useRef(false);
  const prevWidthBucketRef = useRef<'narrow' | 'mid' | 'wide' | null>(null);
  // Auto-colapso da barra de sessões por largura real da área de chat. Só age
  // em CRUZAMENTOS de faixa (histerese 600/660 p/ não flapar no meio): entrar
  // em 'narrow' colapsa; entrar em 'wide' reexpande SE fomos nós que
  // colapsamos. O toggle manual limpa `autoCollapsedRef`, então nunca
  // reabrimos um colapso manual nem re-colapsamos um "abrir" manual.
  // DEVE ficar APÓS a declaração de `chatAreaWidth` (o dep array é avaliado no
  // render — referenciar antes cai na TDZ do const).
  useEffect(() => {
    if (chatAreaWidth === 0) return; // ainda não medido
    const bucket = chatAreaWidth < 600 ? 'narrow' : chatAreaWidth > 660 ? 'wide' : 'mid';
    const prev = prevWidthBucketRef.current;
    prevWidthBucketRef.current = bucket;
    if (prev === bucket || bucket === 'mid') return; // age só em transições reais
    if (bucket === 'narrow' && !sidebarCollapsed) {
      sessionsPanelRef.current?.collapse();
      autoCollapsedRef.current = true;
    } else if (bucket === 'wide' && sidebarCollapsed && autoCollapsedRef.current) {
      sessionsPanelRef.current?.expand();
      autoCollapsedRef.current = false;
    }
  }, [chatAreaWidth, sidebarCollapsed]);
  const pendingAutoTitle = useRef<Set<string>>(new Set());
  const creatingSessionRef = useRef(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [rollbackPendingSeq, setRollbackPendingSeq] = useState<number | null>(null);
  const rollbackInFlightRef = useRef(false);
  const [sessionImportOpen, setSessionImportOpen] = useState(false);
  // Global mode: the multi-project create dialog (project multi-select).
  const [globalNewOpen, setGlobalNewOpen] = useState(false);
  // Global mode: the "manage workspace projects" dialog (attach/remove after create).
  const [manageProjectsOpen, setManageProjectsOpen] = useState(false);
  // Chunk latches for the lazy dialogs above: nothing is downloaded until the
  // first open, and once mounted they stay mounted (exit animation + form state
  // behave exactly like the previous static imports).
  const sessionImportEverOpened = useOpenedOnce(sessionImportOpen);
  const globalNewEverOpened = useOpenedOnce(globalNewOpen);
  const manageProjectsEverOpened = useOpenedOnce(manageProjectsOpen);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [renameGroupTarget, setRenameGroupTarget] = useState<CoderSessionGroup | null>(null);
  const [renameGroupName, setRenameGroupName] = useState('');
  const [renameSessionTarget, setRenameSessionTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameSessionTitle, setRenameSessionTitle] = useState('');
  // Snapshots is the only surface that stays as a modal — its content
  // (file diff viewer) needs the full viewport width. The former metrics,
  // tool-stats and details surfaces share one tabbed Insights panel.
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [snapshotPending, setSnapshotPending] = useState(0);
  // Session snapshot file list (by path) shared with the chat's file-edit blocks
  // + turn summaries, the baseline preselected when opening the panel, and a
  // nonce to force a refetch after a user keep/revert (not covered by snapshotTick).
  const [snapshotFiles, setSnapshotFiles] = useState<Map<string, SnapshotFileSummary>>(new Map());
  const [snapshotInitialBaselineId, setSnapshotInitialBaselineId] = useState<string | null>(null);
  const [snapshotRefreshNonce, setSnapshotRefreshNonce] = useState(0);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  /**
   * Single active right-rail panel id. Replaces the boolean pair
   * `metaSidebarOpen` + `workerLogOpen` and the former modal-open flags.
   * `null` collapses
   * the right panel entirely; the activity rail itself stays visible.
   *
   * Persisted so the user's preferred default panel survives reloads.
   */
  const [activeRightPanelId, setActiveRightPanelId] = useState<RightPanelId | null>(() => {
    if (typeof window === 'undefined') return 'meta';
    const saved = localStorage.getItem('chatRightPanelId');
    // Backward-compat: honor the old `chatMetaSidebarOpen=false` flag so
    // existing users who explicitly hid the meta sidebar don't get it
    // popping back on the next reload.
    if (saved === null) {
      const legacyMetaClosed = localStorage.getItem('chatMetaSidebarOpen') === 'false';
      return legacyMetaClosed ? null : 'meta';
    }
    if (saved === 'null') return null;
    // Migrate the old split Skills/Tools panels into the merged config cog.
    if (saved === 'skills' || saved === 'tools') return 'config';
    // A preview selection is project-scoped. Do not briefly open an empty
    // right dock when restoring this global preference in another project.
    if (saved === 'preview' && !previewAvailable) return null;
    // Metrics, details and tool stats now share one session-insights surface.
    if (saved === 'metrics' || saved === 'details' || saved === 'tool-stats') {
      const migratedTab: SessionInsightsTab = saved === 'metrics'
        ? 'usage'
        : saved === 'tool-stats'
          ? 'tools'
          : 'overview';
      localStorage.setItem(SESSION_INSIGHTS_TAB_STORAGE_KEY, migratedTab);
      return 'insights';
    }
    return saved as RightPanelId;
  });
  useEffect(() => {
    const open = (event: Event) => { if ((event as CustomEvent).detail?.sessionId === selectedId) setActiveRightPanelId('collaboration'); };
    window.addEventListener('coder:open-collaboration', open);
    return () => window.removeEventListener('coder:open-collaboration', open);
  }, [selectedId]);
  useEffect(() => {
    localStorage.setItem('chatRightPanelId', activeRightPanelId ?? 'null');
  }, [activeRightPanelId]);
  useEffect(() => {
    if (activeRightPanelId === 'preview' && !previewAvailable) {
      setActiveRightPanelId(null);
    }
  }, [activeRightPanelId, previewAvailable]);
  useEffect(() => {
    workbenchSlots?.onSessionStateChange?.({
      hasSession: selectedId != null,
      rightPanelOpen: selectedId != null && activeRightPanelId != null,
    });
  }, [activeRightPanelId, selectedId, workbenchSlots?.onSessionStateChange]);
  // Plugin tool windows for the right rail (side: 'right'), with dead-id guard.
  // In global mode there's no fixed project — scope plugin panels to the active
  // linked project (0 = none, so no contributions match, which is fine).
  const pluginPanelWindows = usePluginPanels((isGlobal ? activeProjectId : projectId) ?? 0, activeRightPanelId, setActiveRightPanelId);
  const [thinking, setThinking] = useState(false);
  /**
   * Per-session "Describe images" flag. FORCES the vision fallback (image →
   * text description via the configured vision model) even when the active
   * model can see images — handy to get a textual layout spec. Auto-fallback
   * for blind models happens regardless. Propagated via POST /messages
   * `{describe_images: true}` → runCoder → runner.opts.describeImages.
   */
  const [describeImages, setDescribeImages] = useState(false);
  const [blockCodeComments, setBlockCodeComments] = useState(true);
  const sessionUrl = selectedId ? `/coder/sessions/${selectedId}?tail=40&detail=preview` : '';
  const { data: sessionData, refetch: refetchSession, update: updateSessionData } = useApi<SessionData>(sessionUrl);
  const selectedSessionData = useMemo(
    () => sessionDataForSelection(sessionData, selectedId),
    [selectedId, sessionData],
  );
  // Reuse visible-chat metadata for the shell's pin button, with no global scan.
  const activeSessionTitle = selectedSessionData?.session.title
    ?? sessions?.find((session) => session.id === selectedId)?.title;
  useEffect(() => {
    if (!selectedId || !activeSessionTitle) return;
    const session = { id: selectedId, title: activeSessionTitle };
    useActiveSurface.getState().setSession(session);
    return () => {
      if (useActiveSurface.getState().session === session) {
        useActiveSurface.getState().setSession(null);
      }
    };
  }, [selectedId, activeSessionTitle]);
  const {
    agent,
    setAgent: handleAgentChange,
    awaitPendingAgentChange,
    adoptAgent,
    getAgent,
  } = useSessionAgent({
    selectedId,
    sessionData: selectedSessionData,
    updateSessionData,
    updateSessions,
    refetchSession,
  });
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const sessionDataRef = useRef(selectedSessionData);
  const worktrees = useSessionWorktrees({
    projectId, isGlobal, sessions, selectedId,
    selectedSession: selectedSessionData?.session ?? null,
    onSelect: setSelectedId,
  });
  sessionDataRef.current = selectedSessionData;
  const messagePageAbortControllersRef = useRef<Set<AbortController>>(new Set());
  useEffect(() => () => {
    for (const controller of messagePageAbortControllersRef.current) controller.abort();
    messagePageAbortControllersRef.current.clear();
  }, [selectedId]);

  // Indexing is background work. Keep the project's progress visible without
  // coupling composer availability to structural/semantic readiness: the runner
  // starts in degraded retrieval mode and promotes itself once the index is ready.
  const projectIndexId = selectedSessionData?.session.project_id ?? 0;

  // Global mode: root the right-rail file tree at the selected session's primary
  // linked project; re-derive whenever the session (or its payload) changes.
  useEffect(() => {
    if (!isGlobal) return;
    // Ignore a STALE payload still describing the previous session (useApi keeps
    // the old data until the new GET resolves) — clear until the matching one
    // lands, so the file tree never flashes the previous union's root on switch.
    if (sessionData && sessionData.session.id !== selectedId) {
      setActiveProjectId(null);
      return;
    }
    // v2 virtual union: session.project_id is the SYNTHETIC union project; its
    // junction dir shows every linked project as a top-level folder.
    setActiveProjectId(sessionData?.session.project_id ?? null);
  }, [isGlobal, selectedId, sessionData]);

  const notificationContext = useMemo<NotificationSourceContext | undefined>(() => {
    if (!selectedId) return undefined;
    const sessionTitle =
      selectedSessionData?.session.title
      ?? sessions?.find((session) => session.id === selectedId)?.title
      ?? (isGlobal ? 'Global session' : projectName ?? `Project ${projectId}`);

    if (isGlobal) {
      return {
        target: {
          kind: 'global',
          route: `/global?session=${selectedId}`,
          sessionId: selectedId,
          label: sessionTitle,
        },
      };
    }

    if (projectId == null) return undefined;
    return {
      target: {
        kind: 'project',
        route: `/projects/${projectId}?session=${selectedId}`,
        scopeId: projectId,
        sessionId: selectedId,
        label: sessionTitle,
      },
    };
  }, [isGlobal, projectId, projectName, selectedId, selectedSessionData?.session.title, sessions]);

  const stream = useAgentStream(selectedId, notificationContext);
  const {
    streaming,
    doneReason,
    error,
    lastUsage,
    runDelta,
    todos,
    activeProcesses,
    contextStatus,
    indexStatus,
    sidebarRefreshTick,
    tasksRefreshTick,
    snapshotTick,
    snapshotInventoryTick,
    pendingApprovals,
    lastEventAt,
    preflight,
    sendMessage,
    reattach,
    abort,
    clearCurrentTurn,
    answerQuestion,
    respondToPlan,
    decideGate,
    respondToTasks,
    respondToSpec,
    respondToToolApproval,
  } = stream;

  const { onSwitchProvider: handleSwitchProvider, providerChange, retryProviderChange } = useSessionProvider({
    selectedId, sessionData: selectedSessionData, setProvider, setModel,
    updateSessionData, refetchSessions,
  });

  const runnerLocksExecutionMode = executionModeChangeLocked(
    streaming,
    selectedSessionData?.session.status,
    selectedSessionData?.session.id,
    selectedId,
  );
  const {
    executionMode,
    setExecutionMode: handleExecutionModeChange,
    executionModePending,
    executionModeLocked,
    awaitPendingExecutionMode,
    adoptExecutionMode,
  } = useSessionExecutionMode({
    selectedId,
    sessionData: selectedSessionData,
    updateSessionData,
    runnerBusy: runnerLocksExecutionMode,
    refetchSession,
  });

  const unreadNotifications = useUnreadNotificationCount(selectedId);

  // Builder/DS studio: gate the preview's auto-fix loop while this chat runs.
  usePublishAgentBusy(selectionPrefixSessionId, streaming);

  const { providerOptions, currentProviderModels, getModelsForProvider, tasksState, stats } =
    useAgentChatState({
      selectedId,
      doneReason,
      tasksRefreshTick,
      sessionData: selectedSessionData,
      provider,
    });

  // Snapshot counts/diffs are refreshed on selection, explicit review actions,
  // and once per completed edit tool. The lower-frequency tool boundary keeps
  // live file cards current without recomputing the full inventory for every
  // individual filesystem write inside a multi-file edit.
  useEffect(() => {
    if (!selectedId) {
      setSnapshotPending(0);
      setSnapshotFiles(new Map());
      return;
    }
    let cancelled = false;
    // includeClosed so historical turns' summaries still resolve counts/diffs
    // after the user keeps/reverts (which closes the baseline).
    fetchSnapshotList('coder', selectedId, {
      includeClosed: true,
      refreshKey: `${snapshotInventoryTick}:${snapshotRefreshNonce}`,
    })
      .then((r) => {
        if (cancelled) return;
        const pending = r.files
          .filter((f) => f.status === 'active')
          .reduce((acc, f) => acc + (f.pendingHunks || (f.hunkCount === 0 ? 1 : 0)), 0);
        setSnapshotPending(pending);
        setSnapshotFiles(buildSnapshotFileMap(r.files));
      })
      .catch(() => {
        if (!cancelled) {
          setSnapshotPending(0);
          setSnapshotFiles(new Map());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, snapshotRefreshNonce, snapshotInventoryTick]);

  const previousSnapshotTick = useRef(snapshotTick);
  useEffect(() => {
    if (previousSnapshotTick.current === snapshotTick) return;
    previousSnapshotTick.current = snapshotTick;
    if (selectedId) setSnapshotPending((current) => Math.max(1, current));
  }, [selectedId, snapshotTick]);

  // Honor initialSessionId on mount and whenever it changes (e.g. the user
  // clicks a different recent-session entry while the same project is open).
  useEffect(() => {
    if (initialSessionId && initialSessionId !== selectedId) {
      setSelectedId(initialSessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSessionId]);

  // Project switch: the chat tab is kept mounted (keep-alive) and re-rendered
  // in place with the new projectId — selectedId would otherwise keep pointing
  // at the PREVIOUS project's session, so the transcript, live SSE stream, and
  // the composer + its per-session draft would all stay bound to the old
  // project (and a message sent after switching would land in it). Drop the
  // selection when projectId changes so the chat falls back to the new
  // project's session list (EmptyChatState), unless a deep-linked session was
  // provided for the incoming project (the initialSessionId effect re-selects).
  const prevProjectIdRef = useRef(projectId);
  useEffect(() => {
    if (prevProjectIdRef.current === projectId) return;
    prevProjectIdRef.current = projectId;
    setSelectedId(initialSessionId ?? null);
    clearCurrentTurn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Auto-reattach: when a session is selected, probe for an in-flight run on
  // the server. If one exists, open the /attach SSE so the dashboard resumes
  // the live stream the user was seeing before they closed the tab.
  useEffect(() => {
    if (!selectedId || streaming) return;
    let cancelled = false;
    fetch(`/api/coder/sessions/${selectedId}/status`)
      .then((r) => (r.ok ? r.json() : { active: false }))
      .then((s: { active: boolean }) => {
        if (cancelled || !s.active) return;
        void reattach(selectedId, () => refetchSession());
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    if (!doneReason || !selectedId) return;
    let cancelled = false;
    (async () => {
      await Promise.resolve(refetchSession());
      await Promise.resolve(refetchSessions());
      if (!cancelled) {
        window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
        window.dispatchEvent(new CustomEvent('coder:chapters-changed', {
          detail: { sessionId: selectedId },
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doneReason, selectedId, refetchSession, refetchSessions]);

  const persistedMessageCount = selectedSessionData?.messages.length ?? 0;

  // Bump the SessionStateSidebar refresh key whenever a turn ends — that's
  // the cheapest place to catch goal / tasks state mutations without
  // wiring a per-tool listener. Network cost is negligible (1 fetch / turn
  // boundary) and the user gets fresh banner state right after each model
  // response. Also bumps on session change.
  const [stateRefreshKey, setStateRefreshKey] = useState(0);
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) {
      setStateRefreshKey((k) => k + 1);
    }
    wasStreamingRef.current = streaming;
  }, [streaming]);

  const handleTaskToolCompleted = useCallback(
    () => setStateRefreshKey((key) => key + 1),
    [],
  );

  // File picks: paths selected in ProjectFilesSection that get injected as
  // `<file_refs>` into the next outgoing message. Lives here (not inside the
  // sidebar) so it survives section collapse / scroll.
  const [filePicks, setFilePicks] = useState<string[]>([]);
  const togglePick = useCallback((path: string) => {
    setFilePicks((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]));
  }, []);
  const setManyPicks = useCallback((paths: string[], select: boolean) => {
    setFilePicks((prev) => {
      if (select) {
        const set = new Set(prev);
        for (const p of paths) set.add(p);
        return Array.from(set);
      }
      const drop = new Set(paths);
      return prev.filter((p) => !drop.has(p));
    });
  }, []);
  const clearPicks = useCallback(() => setFilePicks([]), []);

  // Reset picks when switching sessions.
  useEffect(() => {
    setFilePicks([]);
  }, [selectedId]);

  const createSession = useCallback(async (
    config: Partial<SessionLaunchConfig> & { useLastModel?: boolean } = {},
  ) => {
    if (creatingSessionRef.current) return null;
    creatingSessionRef.current = true;
    setSessionCreateError(null);
    setCreatingSession(true);
    try {
      const selectedProvider = config.provider || provider;
      const selectedModels = getModelsForProvider(selectedProvider);
      const selectedModel = config.model || model || firstModelValue(selectedModels)
        || PROVIDERS.find((candidate) => candidate.id === selectedProvider)?.defaultModel;
      const selectedAgent = config.agent ?? agent;
      const selectedReasoningEffort = config.useLastModel
        ? null
        : (config.reasoningEffort === undefined ? reasoningEffort : config.reasoningEffort);
      const selectedExecutionMode = config.useLastModel
        ? 'standard'
        : (config.executionMode === undefined ? executionMode : config.executionMode);
      const selectedThinking = config.useLastModel ? false : (config.thinking ?? thinking);
      // Every new conversation starts unlimited unless its launch dialog
      // explicitly enables a turn ceiling.
      const selectedMaxTurns = config.maxTurns ?? null;
      const selectedMaxAutoContinues =
        config.maxAutoContinues ?? DEFAULT_SESSION_MAX_AUTO_CONTINUES;
      const selectedTemperature = config.useLastModel
        ? null
        : (config.temperature === undefined ? sessionTemperature : config.temperature);
      const explicitTitle = config.title?.trim();
      const created = await apiPost<CoderSession>('/coder/sessions', {
        worktree_path: worktrees.path,
        project_id: projectId,
        title: (explicitTitle || 'Nova sessão').slice(0, 80),
        provider: selectedProvider,
        model: selectedModel,
        use_last_model: config.useLastModel === true,
        agent: selectedAgent,
        reasoning_effort: selectedReasoningEffort || null,
        execution_mode: selectedExecutionMode,
        thinking_enabled: selectedThinking,
        max_turns: selectedMaxTurns,
        max_auto_continues: selectedMaxAutoContinues,
      });
      if (selectedTemperature !== null) {
        await apiPatch(`/coder/sessions/${created.id}/temperature`, { temperature: selectedTemperature }).catch(() => {});
      }
      setProvider(created.provider);
      setModel(created.model);
      adoptAgent(selectedAgent, null);
      setReasoningEffort(selectedReasoningEffort);
      adoptExecutionMode(selectedExecutionMode);
      setThinking(selectedThinking);
      setMaxTurns(selectedMaxTurns);
      setMaxAutoContinues(selectedMaxAutoContinues);
      setSessionTemperature(selectedTemperature);
      if (!explicitTitle) pendingAutoTitle.current.add(created.id);
      refetchSessions();
      setSelectedId(created.id);
      window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
      return created;
    } finally {
      creatingSessionRef.current = false;
      setCreatingSession(false);
    }
  }, [projectId, provider, model, getModelsForProvider, agent, reasoningEffort, executionMode, adoptExecutionMode, adoptAgent, thinking, sessionTemperature, refetchSessions, worktrees.path]);

  const createGlobalSession = async (opts: { title?: string; projectIds?: number[]; primaryProjectId?: number; reuseSessionId?: string }) => {
    const created = await apiPost<CoderSession>('/coder/sessions/global', {
      ...(opts.reuseSessionId
        ? { reuse_session_id: opts.reuseSessionId }
        : { project_ids: opts.projectIds, primary_project_id: opts.primaryProjectId }),
      title: (opts.title ?? 'Nova sessão global').slice(0, 80),
      provider,
      model: model || PROVIDERS.find((p) => p.id === provider)?.defaultModel,
      agent,
      // A global workspace spans projects and must never inherit the mode of
      // whichever conversation happened to be selected before opening it.
      execution_mode: DEFAULT_NEW_EXECUTION_MODE,
    });
    adoptExecutionMode(DEFAULT_NEW_EXECUTION_MODE);
    if (!opts.title) pendingAutoTitle.current.add(created.id);
    refetchSessions();
    setSelectedId(created.id);
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
    return created;
  };

  const handleNewSession = useCallback(() => {
    if (worktrees.unavailable) {
      setSessionCreateError(t('chat:worktrees.unavailable'));
      return;
    }
    // Global mode opens the project multi-select dialog instead of an
    // immediate single-project create.
    if (isGlobal) {
      setGlobalNewOpen(true);
      return;
    }
    void createSession({ useLastModel: true }).catch((error) => {
      setSessionCreateError(error instanceof Error ? error.message : String(error));
      console.warn('[new-session] creation failed:', error);
    });
  }, [isGlobal, createSession, worktrees.unavailable, t]);

  const handleOpenImport = useCallback(() => setSessionImportOpen(true), []);
  const handleImportedSession = useCallback((sessionId: string) => {
    refetchSessions();
    setSelectedId(sessionId);
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [refetchSessions]);

  const handleSend = useCallback(async (text: string, atts: AgentAttachment[], selectedSkillIds?: string[]) => {
    if (!text.trim() || !selectedId) return;
    let autoTitlePending = pendingAutoTitle.current.has(selectedId);
    if (autoTitlePending) pendingAutoTitle.current.delete(selectedId);
    // Builder studio: prepend the selected-element block(s) and drain any
    // region-select screenshot(s) into the attachments (then clear both).
    const prefix = selectionPrefixSessionId ? consumeSelectionPrefix(selectionPrefixSessionId) : '';
    const shots = selectionPrefixSessionId ? consumePendingAttachments(selectionPrefixSessionId) : [];
    const outgoing = prefix ? `${prefix}\n${text}` : text;
    const allAtts = shots.length ? [...atts, ...shots] : atts;
    const optimisticMessageId = allocateOptimisticMessageId();
    updateSessionData((previous) => appendOptimisticUserMessage(previous, {
      sessionId: selectedId,
      messageId: optimisticMessageId,
      text: outgoing,
      attachments: allAtts,
      selectedSkillIds,
    }));
    // The mode is baked into runner construction. Never let the send race the
    // preceding PATCH (including sends initiated outside the visible composer).
    await Promise.all([
      awaitPendingExecutionMode(),
      awaitPendingAgentChange(),
    ]);
    await sendMessage(outgoing, async () => {
      refetchSession();
      if (autoTitlePending) {
        // Stream refetch notifications can occur at interactive/user
        // boundaries as well as provider completion. Title generation belongs
        // to the first notification only.
        autoTitlePending = false;
        apiPost<{ title: string }>(`/coder/sessions/${selectedId}/generate-title`, { content: text })
          .then(() => {
            refetchSessions();
            window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
          })
          .catch((err) => {
            // Visible diagnostic instead of silent swallow — auto-title
            // failures used to be invisible (no provider configured, OAuth
            // provider, etc.) and the user had no way to tell what went wrong.
            console.warn('[auto-title] generate-title failed:', err);
          });
      }
    }, { attachments: allAtts, agent: getAgent(), maxTurns, maxAutoContinues, thinking, describeImages, blockCodeComments, selectedSkillIds, freshSession: persistedMessageCount === 0 });
  }, [selectedId, updateSessionData, awaitPendingExecutionMode, awaitPendingAgentChange, sendMessage, refetchSession, refetchSessions, getAgent, maxTurns, maxAutoContinues, thinking, describeImages, blockCodeComments, selectionPrefixSessionId, persistedMessageCount]);

  // ─── Message queue (compose/enqueue while streaming) ───────────────
  // Delivery is run-state-aware and serves BOTH queue modes:
  //   • live run  → POST /inject (JSON, NO new stream): enqueues into the live
  //     runner; the already-open SSE renders the agent's next turn. Calling
  //     sendMessage here would open a 2nd stream that aborts the live one and
  //     wipes the in-flight turn (the freeze bug) — so we never do that mid-run.
  //   • no run    → /inject returns { noActiveRun }; fall back to sendMessage,
  //     which opens a fresh streamed run (the end-of-session path).
  const deliverQueued = useCallback<QueueDeliver>(async (
    text,
    { interject, attachments, skillIds },
  ) => {
    if (!selectedId) return;
    await sessionProviderSwitches.wait(selectedId);
    try {
      const r = await apiPost<{ injected?: boolean; noActiveRun?: boolean; waiting?: boolean }>(
        `/coder/sessions/${selectedId}/inject`,
        {
          content: text,
          interject,
          attachments,
          describe_images: describeImages,
          selected_skill_ids: skillIds,
        },
      );
      // The persisted user row must become visible only after the live runner
      // emits user_message_boundary and clears the preceding turn buffer. The
      // stream handler performs that ordered refetch; doing it here creates a
      // brief duplicated transcript between POST /inject and the next turn.
      if (r?.injected) return;
    } catch { /* fall through to a fresh streamed send */ }
    await Promise.all([
      awaitPendingExecutionMode(),
      awaitPendingAgentChange(),
    ]);
    await sendMessage(text, async () => { refetchSession(); }, {
      attachments,
      agent: getAgent(),
      maxTurns,
      maxAutoContinues,
      thinking,
      describeImages,
      blockCodeComments,
      selectedSkillIds: skillIds,
      interject,
    });
  }, [selectedId, awaitPendingExecutionMode, awaitPendingAgentChange, sendMessage, refetchSession, getAgent, maxTurns, maxAutoContinues, thinking, describeImages, blockCodeComments]);
  const queue = useMessageQueue({ streaming, deliver: deliverQueued });
  const handleQueue = useCallback((
    text: string,
    mode: QueueMode,
    attachments: AgentAttachment[],
    skillIds?: string[],
  ) => {
    if (!selectedId) return;
    const prefix = selectionPrefixSessionId ? consumeSelectionPrefix(selectionPrefixSessionId) : '';
    const shots = selectionPrefixSessionId
      ? consumePendingAttachments(selectionPrefixSessionId)
      : [];
    queue.enqueue(
      prefix ? `${prefix}\n${text}` : text,
      mode,
      shots.length > 0 ? [...attachments, ...shots] : attachments,
      skillIds,
    );
  }, [selectedId, selectionPrefixSessionId, queue]);
  // Discard the queue AND any staged region screenshot when switching sessions.
  // Both are ephemeral; the screenshot is keyed by the builder project (not the
  // chat session), so without this it would bleed into the next session's first
  // send (the Composer doesn't surface it, so it'd be an invisible mis-attach).
  useEffect(() => {
    queue.clear();
    if (selectionPrefixSessionId) consumePendingAttachments(selectionPrefixSessionId);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Builder preview "Fix" / auto-fix → send a message into this chat.
  // Scoped to the builder key (the project id) so only this chat reacts.
  useEffect(() => {
    if (selectionPrefixSessionId == null) return;
    return onStudioSend(selectionPrefixSessionId, (text) => { void handleSend(text, []); });
  }, [selectionPrefixSessionId, handleSend]);

  const handleSnapshotReviewMessage = useCallback(async (message: string) => {
    if (!message.trim() || !selectedId) return;
    setSnapshotsOpen(false);
    const reviewAgent = agent === 'explore' || agent === 'plan' ? 'build' : agent;
    await Promise.all([
      awaitPendingExecutionMode(),
      awaitPendingAgentChange(),
    ]);
    await sendMessage(message, async () => {
      refetchSession();
    }, { agent: reviewAgent, maxTurns, maxAutoContinues, thinking, describeImages, blockCodeComments });
  }, [selectedId, awaitPendingExecutionMode, awaitPendingAgentChange, sendMessage, refetchSession, agent, maxTurns, maxAutoContinues, thinking, describeImages, blockCodeComments]);

  const loadEarlierMessages = useCallback(async (
    beforeSeq: number | undefined,
    limit = 40,
    includeArchived = false,
  ): Promise<EarlierMessagePageResult> => {
    const requestedSessionId = selectedId;
    if (!requestedSessionId) return { ok: false, reason: 'stale' };
    const controller = new AbortController();
    messagePageAbortControllersRef.current.add(controller);
    try {
      const qs = new URLSearchParams({ limit: String(limit) });
      qs.set('detail', 'preview');
      if (beforeSeq != null) qs.set('before_seq', String(beforeSeq));
      if (includeArchived) qs.set('include_archived', '1');
      const res = await fetch(`/api/coder/sessions/${requestedSessionId}/messages?${qs}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        return { ok: false, reason: 'error', error: `HTTP ${res.status}` };
      }
      const page = (await res.json()) as MessagePage;
      if (selectedIdRef.current !== requestedSessionId) return { ok: false, reason: 'stale' };
      const current = sessionDataRef.current;
      if (!current || current.session.id !== requestedSessionId) return { ok: false, reason: 'stale' };
      const preview = mergeEarlierMessagePage(current, page, requestedSessionId);
      if (preview.addedRows > 0) {
        updateSessionData((prev) => mergeEarlierMessagePage(prev, page, requestedSessionId).data);
      }
      return {
        ok: true,
        addedRows: preview.addedRows,
        nextBeforeSeq: page.next_before_seq,
        hasMore: page.has_more,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { ok: false, reason: 'aborted' };
      }
      return {
        ok: false,
        reason: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      messagePageAbortControllersRef.current.delete(controller);
    }
  }, [selectedId, updateSessionData]);

  // Fallback: load from session when selected, save when changed
  useEffect(() => {
    if (!selectedId) return;
    fetch(`/api/coder/sessions/${selectedId}/fallback`)
      .then((r) => r.json())
      .then((data: { fallback_provider: string | null; fallback_model: string | null }) => {
        setFallbackProvider(data.fallback_provider);
        setFallbackModel(data.fallback_model);
      })
      .catch(() => {});
  }, [selectedId]);

  // Temperature override: load from the selected session row. The full session
  // payload already includes `temperature_override` since the column flows
  // through `SELECT *` mapping; no extra endpoint needed for read.
  useEffect(() => {
    if (!sessionData?.session) {
      setSessionTemperature(null);
      return;
    }
    const t = (sessionData.session as { temperature_override?: number | null }).temperature_override;
    setSessionTemperature(typeof t === 'number' ? t : null);
  }, [sessionData?.session]);

  // Run limits are filesystem session state. New/legacy sessions project null
  // as unlimited and materialize the historical auto-continue value as 15.
  useEffect(() => {
    const session = sessionData?.session;
    if (!session || session.id !== selectedId) {
      setMaxTurns(null);
      setMaxAutoContinues(DEFAULT_SESSION_MAX_AUTO_CONTINUES);
      return;
    }
    setMaxTurns(
      typeof session.max_turns === 'number' && session.max_turns > 0
        ? session.max_turns
        : null,
    );
    setMaxAutoContinues(
      typeof session.max_auto_continues === 'number'
      && session.max_auto_continues >= 0
        ? session.max_auto_continues
        : DEFAULT_SESSION_MAX_AUTO_CONTINUES,
    );
  }, [selectedId, sessionData?.session]);

  // Reasoning-effort override (migration 150). Same read pattern as temperature —
  // the column flows through the full session payload. Orthogonal to thinking.
  useEffect(() => {
    if (!selectedId) {
      setReasoningEffort(null);
      return;
    }
    const effort = hydratedReasoningEffort(sessionData?.session, selectedId);
    if (effort !== undefined) setReasoningEffort(effort);
  }, [selectedId, sessionData?.session]);

  // Extended thinking (migration 226). Hydrate only after the payload for the
  // currently selected conversation arrives; useApi intentionally retains the
  // previous payload during a switch, and applying that stale row would make
  // the icon flash the wrong session's state.
  useEffect(() => {
    const session = sessionData?.session;
    if (!session || session.id !== selectedId) return;
    setThinking(session.thinking_enabled === true);
  }, [selectedId, sessionData?.session]);

  useEffect(() => {
    const session = sessionData?.session;
    setBlockCodeComments(
      session?.id === selectedId ? session.block_code_comments !== false : true,
    );
  }, [selectedId, sessionData?.session]);

  // Plan-depth override (migration 151). Sticky per session; only surfaced in
  // the composer when the `plan` agent is active. NULL → `normal` at runtime.
  useEffect(() => {
    if (!sessionData?.session) {
      setPlanDepth(null);
      return;
    }
    const d = sessionData.session.plan_depth_override;
    setPlanDepth(typeof d === 'string' && d.length > 0 ? d : null);
  }, [sessionData?.session]);

  // Response-language override (migration 177). Sticky per session; NULL → the
  // project default then the neutral "respond in the user's language" form.
  useEffect(() => {
    const v = sessionData?.session?.response_language_override;
    setResponseLanguage(typeof v === 'string' && v.length > 0 ? v : null);
  }, [sessionData?.session]);

  // Output style (migration 178). NULL → 'proactive' (no extra prompt block).
  useEffect(() => {
    const v = sessionData?.session?.output_style_override;
    setOutputStyle(typeof v === 'string' && v.length > 0 ? v : null);
  }, [sessionData?.session]);

  // Tool-output cap level (migration 153; legacy migration-078 boolean → 'max'
  // fallback). Reads from the session row, writes via PATCH /tool-output-cap-level.
  useEffect(() => {
    setOutputCapLevel(levelFromSession(sessionData?.session));
  }, [sessionData?.session]);

  // Tool permission mode (migration 131). Reads from the session row,
  // writes via PATCH — which also pushes into the live runner mid-run.
  useEffect(() => {
    if (!sessionData?.session) {
      setToolPermissionMode('auto');
      return;
    }
    setToolPermissionMode(sessionData.session.tool_permission_mode ?? 'auto');
  }, [sessionData?.session]);

  const handleTemperatureChange = useCallback(async (next: number | null) => {
    setSessionTemperature(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/temperature`, { temperature: next });
    } catch {
      /* ignore — UI optimistic, server is the source of truth on next refetch */
    }
  }, [selectedId]);

  const handleMaxTurnsChange = useCallback(async (next: number | null) => {
    setMaxTurns(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/run-limits`, {
        max_turns: next,
        max_auto_continues: maxAutoContinues,
      });
    } catch {
      /* optimistic; the session projection restores the durable value */
    }
  }, [maxAutoContinues, selectedId]);

  const handleMaxAutoContinuesChange = useCallback(async (next: number) => {
    setMaxAutoContinues(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/run-limits`, {
        max_turns: maxTurns,
        max_auto_continues: next,
      });
    } catch {
      /* optimistic; the session projection restores the durable value */
    }
  }, [maxTurns, selectedId]);

  const handleReasoningEffortChange = useCallback(async (next: string | null) => {
    setReasoningEffort(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/reasoning-effort`, { effort: next });
    } catch {
      /* ignore — UI optimistic, server is the source of truth on next refetch */
    }
  }, [selectedId]);

  const handleThinkingChange = useCallback(async (next: boolean) => {
    setThinking(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/thinking`, { thinking: next });
    } catch {
      /* optimistic; the persisted value is restored on the next session load */
    }
  }, [selectedId]);

  const handleBlockCodeCommentsChange = useCallback(async (next: boolean) => {
    setBlockCodeComments(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/block-code-comments`, { enabled: next });
    } catch {
      /* optimistic; the persisted value is restored on the next session load */
    }
  }, [selectedId]);

  const handlePlanDepthChange = useCallback(async (next: string | null) => {
    setPlanDepth(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/plan-depth`, { depth: next });
    } catch {
      /* ignore — UI optimistic, server is the source of truth on next refetch */
    }
  }, [selectedId]);

  const handleResponseLanguageChange = useCallback(async (next: string | null) => {
    setResponseLanguage(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/response-language`, { language: next });
    } catch {
      /* ignore — UI optimistic, server is the source of truth on next refetch */
    }
  }, [selectedId]);

  const handleOutputStyleChange = useCallback(async (next: string | null) => {
    setOutputStyle(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/output-style`, { style: next });
    } catch {
      /* ignore — UI optimistic, server is the source of truth on next refetch */
    }
  }, [selectedId]);

  const handleOutputCapLevelChange = useCallback(async (next: OutputCapLevel) => {
    setOutputCapLevel(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/tool-output-cap-level`, { level: next });
    } catch {
      /* ignore — UI optimistic, server is the source of truth on next refetch */
    }
  }, [selectedId]);

  const handleToolPermissionModeChange = useCallback(async (next: 'ask' | 'auto' | 'unrestricted') => {
    setToolPermissionMode(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/tool-permission-mode`, { mode: next });
    } catch {
      /* ignore — UI optimistic, server is the source of truth on next refetch */
    }
  }, [selectedId]);

  const handleFallbackChange = useCallback(async (fbProvider: string | null, fbModel: string | null) => {
    setFallbackProvider(fbProvider);
    setFallbackModel(fbModel);
    if (selectedId) {
      await fetch(`/api/coder/sessions/${selectedId}/fallback`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: fbProvider, model: fbModel }),
      });
    }
  }, [selectedId]);

  useDeletedSession(selectedId, setSelectedId);
  const deleteConfirmedChats = useCallback(async (ids: string[]) => {
    try { await deleteChats(ids); }
    catch (error) {
      await confirm({ title: t('chat:deleteFailed'), description: error instanceof Error ? error.message : String(error), confirmLabel: t('common:actions.close') });
    } finally { refetchSessions(); }
  }, [confirm, t, refetchSessions]);

  const handleDelete = useCallback(async (id: string) => {
    const ok = await confirm({
      title: t('chat:deleteSession'),
      description: t('chat:deleteSessionDescription'),
      variant: 'destructive',
      confirmLabel: t('common:actions.delete'),
    });
    if (!ok) return;
    await deleteConfirmedChats([id]);
  }, [confirm, t, deleteConfirmedChats]);

  /**
   * Manual "summarize & clear": the backend summarizes the visible transcript
   * with the session's own model, inserts a summary message and moves the
   * boundary so older messages drop out of view (still recoverable). On success
   * we just refetch — the GET respects the new boundary, so the chat collapses
   * to the summary card on its own.
   */
  const handleSummarizeClear = useCallback(async () => {
    if (selectedId == null || summarizing) return;
    const ok = await confirm({
      title: t('chat:header.summarizeClear'),
      description: t('chat:header.summarizeClearConfirm'),
      confirmLabel: t('chat:header.summarizeClearConfirmLabel'),
    });
    if (!ok) return;
    setSummarizing(true);
    try {
      await apiPost(`/coder/sessions/${selectedId}/summarize-and-clear`, {});
      await Promise.resolve(refetchSession());
      await Promise.resolve(refetchSessions());
      window.dispatchEvent(new CustomEvent('coder:chapters-changed', {
        detail: { sessionId: selectedId },
      }));
    } catch (e) {
      await confirm({
        title: t('chat:header.summarizeClearFailed'),
        description: e instanceof Error ? e.message : String(e),
        confirmLabel: t('common:actions.close'),
      });
    } finally {
      setSummarizing(false);
    }
  }, [selectedId, summarizing, confirm, refetchSession, refetchSessions, t]);

  const handleBatchDelete = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    const ok = await confirm({
      title: t('chat:deleteSessions', { count: ids.length }),
      description: t('chat:deleteSessionsDescription'),
      variant: 'destructive',
      confirmLabel: t('common:actions.delete'),
    });
    if (!ok) return;
    await deleteConfirmedChats(ids);
  }, [confirm, t, deleteConfirmedChats]);

  const handleDeleteAll = useCallback(async () => {
    const ids = (worktrees.visible ?? []).map((s) => s.id);
    if (ids.length === 0) return;
    const ok = await confirm({
      title: t('chat:deleteAllSessions', { count: ids.length }),
      description: t(
        view === 'archived' ? 'chat:deleteAllArchivedDescription' : 'chat:deleteAllActiveDescription',
      ),
      variant: 'destructive',
      confirmLabel: t('common:actions.delete'),
    });
    if (!ok) return;
    await deleteConfirmedChats(ids);
  }, [worktrees.visible, confirm, t, view, deleteConfirmedChats]);

  const handleArchive = useCallback(async (id: string, archived: boolean) => {
    await apiPatch(`/coder/sessions/${id}/archive`, { archived });
    // Session leaves the current view — drop selection.
    if (selectedId === id) setSelectedId(null);
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [selectedId, refetchSessions]);

  const handleFavorite = useCallback(async (id: string, favorite: boolean) => {
    await apiPatch(`/coder/sessions/${id}/favorite`, { favorite });
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [refetchSessions]);

  // Pin/unpin a session as a global tab. Scope + projectId come from this
  // chat's mode; the title is looked up from the current list.
  const handleTogglePin = useCallback((id: string) => {
    const s = sessions?.find((x) => x.id === id);
    usePinnedTabs.getState().togglePin(
      buildSessionPin({
        scope: isGlobal ? 'global' : 'project',
        sessionId: id,
        projectId: isGlobal ? undefined : projectId,
        title: s?.title ?? null,
      }),
    );
  }, [sessions, isGlobal, projectId]);
  const sessionPinIdFor = useCallback(
    (id: string) => makeSessionPinId(isGlobal ? 'global' : 'project', id),
    [isGlobal],
  );

  const handleRenameSession = useCallback((id: string, currentTitle: string) => {
    setRenameSessionTarget({ id, title: currentTitle });
    setRenameSessionTitle(currentTitle);
  }, []);

  const confirmRenameSession = async () => {
    if (!renameSessionTarget) return;
    const title = renameSessionTitle.trim();
    if (!title || title === renameSessionTarget.title) {
      setRenameSessionTarget(null);
      return;
    }
    await apiPatch(`/coder/sessions/${renameSessionTarget.id}/title`, { title });
    setRenameSessionTarget(null);
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  };

  const handleDuplicate = useCallback(async (id: string) => {
    const res = await apiPost<{ session: CoderSession }>(`/coder/sessions/${id}/duplicate`, {});
    await refetchSessions();
    setSelectedId(res.session.id);
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [refetchSessions]);
  useEffect(() => {
    const prepared = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string }>).detail;
      if (!detail?.sessionId) return;
      refetchSessions(); setSelectedId(detail.sessionId);
      window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
    };
    window.addEventListener('coder:proposal-prepared', prepared);
    return () => window.removeEventListener('coder:proposal-prepared', prepared);
  }, [refetchSessions]);

  const handleFork = async (messageSeq: number) => {
    if (!selectedId) return;
    const res = await apiPost<{ session: CoderSession; seed_text: string }>(
      `/coder/sessions/${selectedId}/fork`,
      { before_seq: messageSeq },
    );
    await refetchSessions();
    setSelectedId(res.session.id);
    composerRef.current?.setInput(res.seed_text);
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  };

  // Rollback: destructively truncate THIS session at the message, then drop its
  // text + attachments back into the composer for editing & re-sending.
  const handleRollback = async (messageSeq: number) => {
    if (!selectedId || rollbackInFlightRef.current) return;
    const ok = await confirm({
      title: t('chat:rollbackConfirmTitle'),
      description: t('chat:rollbackConfirmDescription'),
      variant: 'destructive',
      confirmLabel: t('chat:rollbackConfirmLabel'),
    });
    if (!ok) return;
    if (rollbackInFlightRef.current) return;
    rollbackInFlightRef.current = true;
    setRollbackPendingSeq(messageSeq);
    // The backend rejects with 409 when a run is active (and 400 on a stale
    // message id). Surface that instead of swallowing it into a silent no-op —
    // the destructive delete either fully succeeds or fully fails server-side.
    try {
      const res = await apiPost<{ seed_text: string; seed_attachments: AgentAttachment[] }>(
        `/coder/sessions/${selectedId}/rollback-to-message`,
        { seq: messageSeq },
      );
      await refetchSession();
      composerRef.current?.setInput(res.seed_text);
      composerRef.current?.setAttachments(res.seed_attachments ?? []);
      refetchSessions();
      window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
    } catch (e) {
      await confirm({
        title: t('chat:rollbackFailed'),
        description: e instanceof Error ? e.message : String(e),
        confirmLabel: t('common:actions.close'),
      });
    } finally {
      rollbackInFlightRef.current = false;
      setRollbackPendingSeq(null);
    }
  };

  const handleBatchArchive = useCallback(async (ids: string[], archived: boolean) => {
    await Promise.all(ids.map((id) => apiPatch(`/coder/sessions/${id}/archive`, { archived })));
    if (selectedId != null && ids.includes(selectedId)) setSelectedId(null);
    refetchSessions();
  }, [selectedId, refetchSessions]);

  const handleMoveToGroup = useCallback(async (id: string, groupId: string | null) => {
    await apiPatch(`/coder/sessions/${id}/group`, { group_id: groupId });
    refetchSessions();
  }, [refetchSessions]);

  const handleBatchMoveToGroup = useCallback(async (ids: string[], groupId: string | null) => {
    await Promise.all(
      ids.map((id) => apiPatch(`/coder/sessions/${id}/group`, { group_id: groupId })),
    );
    refetchSessions();
  }, [refetchSessions]);

  const handleCreateGroup = useCallback(async () => {
    if (isGlobal) return; // groups are per-project; not available in global mode
    setNewGroupName('');
    setNewGroupOpen(true);
  }, [isGlobal]);

  const confirmCreateGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    await apiPost<CoderSessionGroup>('/coder/groups', {
      project_id: projectId,
      name,
    });
    setNewGroupOpen(false);
    setNewGroupName('');
    refetchGroups();
  };

  const handleRenameGroup = useCallback(async (group: CoderSessionGroup) => {
    setRenameGroupTarget(group);
    setRenameGroupName(group.name);
  }, []);

  const confirmRenameGroup = async () => {
    if (!renameGroupTarget) return;
    const name = renameGroupName.trim();
    if (!name || name === renameGroupTarget.name) {
      setRenameGroupTarget(null);
      return;
    }
    await apiPatch(
      `/coder/groups/${renameGroupTarget.id}?project_id=${projectId}`,
      { name },
    );
    setRenameGroupTarget(null);
    refetchGroups();
  };

  const handleDeleteGroup = useCallback(async (group: CoderSessionGroup) => {
    const ok = await confirm({
      title: t('chat:deleteGroup', { name: group.name }),
      description: t('chat:deleteGroupDescription'),
      variant: 'destructive',
      confirmLabel: t('common:actions.delete'),
    });
    if (!ok) return;
    await apiDelete(`/coder/groups/${group.id}?project_id=${projectId}`);
    refetchGroups();
    refetchSessions();
  }, [confirm, t, refetchGroups, refetchSessions, projectId]);

  // Stable handlers reference so the memoized <PersistedMessages /> inside
  // MessageList doesn't re-render on every parent render. Deps are the three
  // useCallback-stable functions from useAgentStream.
  const handlers: PromptHandlers = useMemo(
    () => ({
      onAnswer: (answer, interactionId) => answerQuestion(answer, undefined, { interactionId }),
      onPlanResponse: async (verdict) => {
        await respondToPlan(verdict);
        // Iteration 2: after an approved plan, the backend may auto-transition
        // the session agent from 'plan' to 'build'. Refetch the session
        // metadata so the AgentPicker reflects the new mode without
        // requiring a manual reload. (Skip on revise/abort — agent stays 'plan'.)
        if (verdict.approved && selectedId) {
          try {
            const r = await fetch(`/api/coder/sessions/${selectedId}`);
            if (r.ok) {
              const s = (await r.json()) as { agent?: string };
              if (s.agent && s.agent !== agent && isAgentPreset(s.agent)) {
                adoptAgent(s.agent, selectedId);
              }
            }
          } catch {
            /* non-fatal: AgentPicker just keeps the stale value */
          }
        }
      },
      onTasksResponse: (verdict) => respondToTasks(verdict),
      onDecide: (answers, interactionId) => decideGate(answers, undefined, { interactionId }),
      onSpecResponse: async (approved, spec_path, requested_changes, interactionId) => {
        await respondToSpec(approved, spec_path, requested_changes, undefined, { interactionId });
        // After approval the backend transitions agent 'spec' → 'build'. Refresh
        // the local agent state so the picker reflects the new mode.
        if (approved && selectedId) {
          try {
            const r = await fetch(`/api/coder/sessions/${selectedId}`);
            if (r.ok) {
              const s = (await r.json()) as { agent?: string };
              if (s.agent && s.agent !== agent && isAgentPreset(s.agent)) {
                adoptAgent(s.agent, selectedId);
              }
            }
          } catch {
            /* non-fatal */
          }
        }
      },
      onFork: handleFork,
      onRollback: handleRollback,
      rollbackPendingSeq,
      onToolApproval: (toolUseId, verdict) => respondToToolApproval(toolUseId, verdict),
      // P1 (ultra-agent parity): lets live agent rows abort ONE subagent /
      // fetch its retained transcript without plumbing a separate context.
      sessionId: selectedId ?? undefined,
    }),
    // handleFork / handleRollback depend on selectedId — re-create on switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [answerQuestion, respondToPlan, decideGate, respondToTasks, respondToSpec, respondToToolApproval, selectedId, agent, adoptAgent, rollbackPendingSeq],
  );

  // Stable handlers for the memoized children (ChatHeader / ChatRightRail) and
  // the sidebar — all are pure setState calls (deps []), so a composer or
  // right-panel click no longer allocates a fresh arrow per child each render.
  const openDetailsPanel = useCallback(() => {
    localStorage.setItem(SESSION_INSIGHTS_TAB_STORAGE_KEY, 'overview');
    window.dispatchEvent(new CustomEvent<SessionInsightsTab>(SESSION_INSIGHTS_TAB_EVENT, {
      detail: 'overview',
    }));
    setActiveRightPanelId('insights');
  }, []);
  const openMobileSidebar = useCallback(() => setMobileSidebarOpen(true), []);
  const toggleCanvasPanel = useCallback(
    () => setActiveRightPanelId((p) => (p === 'diagram' ? null : 'diagram')),
    [],
  );
  const openSnapshots = useCallback((baselineId?: string) => {
    setSnapshotInitialBaselineId(baselineId ?? null);
    setSnapshotsOpen(true);
  }, []);
  const refreshSnapshots = useCallback(() => setSnapshotRefreshNonce((n) => n + 1), []);
  const snapshotActions = useMemo<SnapshotActions>(
    () => ({ scope: 'coder', sessionId: selectedId ?? '', openSnapshots, refresh: refreshSnapshots }),
    [selectedId, openSnapshots, refreshSnapshots],
  );
  const handleViewChange = useCallback((v: 'active' | 'archived') => {
    setView(v);
    setSelectedId(null);
  }, []);
  const handleSelectSession = useCallback((id: string) => {
    setSelectedId(id);
    setMobileSidebarOpen(false);
    workbenchSlots?.onSessionSelected?.(id);
  }, [workbenchSlots?.onSessionSelected]);
  const closeMobileSidebar = useCallback(() => setMobileSidebarOpen(false), []);

  // Stabilize the two inline-computed <Composer> props. Without these, each
  // parent render would allocate a fresh array / React element and bust the
  // Composer memo even though nothing the composer cares about changed.
  const reasoningLevels = useMemo(
    () => resolveReasoningLevels(provider, providerOptions, model),
    [provider, providerOptions, model],
  );
  const ultraControlsThinking = useMemo(
    () => ultraManagesThinking(executionMode, modelCanReason(provider, providerOptions, model)),
    [executionMode, provider, providerOptions, model],
  );
  const queuedStrip = useMemo(
    () => <QueuedMessages items={queue.items} onPromote={queue.promote} onRemove={queue.remove} />,
    [queue.items, queue.promote, queue.remove],
  );

  const workspaceBar = (
    <SessionWorkspaceBar
      key={projectId ?? 'global'} projectId={projectId} isGlobal={isGlobal}
      path={worktrees.path} data={worktrees.data} loading={worktrees.loading}
      error={worktrees.error} unavailable={worktrees.unavailable} sessionError={sessionCreateError}
      actionsRef={sessionActionsRef} onRefresh={worktrees.refetch}
      onSelect={(path) => { setSessionCreateError(null); worktrees.switchTo(path); }}
    />
  );

  return (
    // Tooltips use the single root <TooltipProvider> in App.tsx — a nested one
    // here was redundant (extra Radix context layer re-rendering on every chat
    // state change). Removed; the remaining rich Radix tooltips still work.
    <>
      {isGlobal && globalNewEverOpened && (
        <Suspense fallback={null}>
          <GlobalNewSessionDialog
            open={globalNewOpen}
            onOpenChange={setGlobalNewOpen}
            onCreate={createGlobalSession}
          />
        </Suspense>
      )}
      {isGlobal && selectedId != null && manageProjectsEverOpened && (
        <Suspense fallback={null}>
          <ManageGlobalProjectsDialog
            open={manageProjectsOpen}
            onOpenChange={setManageProjectsOpen}
            sessionId={selectedId}
            linkedProjects={sessionData?.linked_projects ?? []}
            streaming={streaming}
            onChanged={() => { void refetchSession(); }}
          />
        </Suspense>
      )}
      <Dialog open={newGroupOpen} onOpenChange={setNewGroupOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('chat:newGroup')}</DialogTitle>
            <DialogDescription>{t('chat:newGroupDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={t('chat:groupNamePlaceholder')}
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmCreateGroup();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewGroupOpen(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button onClick={confirmCreateGroup} disabled={!newGroupName.trim()}>
              {t('common:actions.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!renameGroupTarget}
        onOpenChange={(open) => { if (!open) setRenameGroupTarget(null); }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('chat:renameGroup')}</DialogTitle>
            <DialogDescription>{t('chat:renameGroupDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={t('chat:groupNamePlaceholder')}
            value={renameGroupName}
            onChange={(e) => setRenameGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmRenameGroup();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameGroupTarget(null)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              onClick={confirmRenameGroup}
              disabled={!renameGroupName.trim() || renameGroupName.trim() === renameGroupTarget?.name}
            >
              {t('common:actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!renameSessionTarget}
        onOpenChange={(open) => { if (!open) setRenameSessionTarget(null); }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('chat:renameSession')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={t('chat:sessionNamePlaceholder')}
            value={renameSessionTitle}
            onChange={(e) => setRenameSessionTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirmRenameSession(); }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameSessionTarget(null)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              onClick={confirmRenameSession}
              disabled={!renameSessionTitle.trim() || renameSessionTitle.trim() === renameSessionTarget?.title}
            >
              {t('common:actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {!isGlobal && projectId != null && sessionImportEverOpened && (
        <Suspense fallback={null}>
          <SessionImportDialog
            open={sessionImportOpen}
            onOpenChange={setSessionImportOpen}
            projectId={projectId}
            projectName={projectName ?? ''}
            provider={provider}
            model={model || PROVIDERS.find((item) => item.id === provider)?.defaultModel || ''}
            agent={agent}
            providerOptions={providerOptions}
            onImported={handleImportedSession}
          />
        </Suspense>
      )}
      {/* Snapshots is the only ex-modal that stays modal — its full-width
          diff viewer needs the viewport. The remaining surfaces live in the rail. */}
      <div ref={chatAreaRef} className="flex h-full min-h-0 flex-col">
        {workbenchSlots?.toolbarHost
          ? createPortal(workspaceBar, workbenchSlots.toolbarHost)
          : workspaceBar}
        <div className="flex min-h-0 flex-1">
        {/* `agent-chat-cols-v2` bumps the persisted-storage key so the
            three-panel layout (sessions / chat / right-rail) gets a fresh
            split instead of inheriting the legacy two-panel sizing — which
            could leave the right panel taking ~50% of the viewport and
            squishing the chat header into a wrap. */}
        <PanelGroup direction="horizontal" autoSaveId="agent-chat-cols-v2" className="flex-1 min-h-0">
        {!workbenchSlots && <Panel
          ref={sessionsPanelRef}
          id="sessions-sidebar"
          order={1}
          defaultSize={20}
          minSize={14}
          maxSize={32}
          collapsible
          collapsedSize={0}
          onCollapse={() => setSidebarCollapsed(true)}
          onExpand={() => setSidebarCollapsed(false)}
          className="min-w-0"
        >
        <SessionSidebar
          actionsHost={sessionActionsHost}
          scopeKey={String(projectId) + ':' + (worktrees.path ?? '')}
          newDisabled={worktrees.unavailable}
          sessions={worktrees.visible ?? null}
          groups={groups ?? null}
          view={view}
          onViewChange={handleViewChange}
          selectedId={selectedId}
          creating={creatingSession}
          onSelect={handleSelectSession}
          mobileOpen={mobileSidebarOpen}
          onMobileClose={closeMobileSidebar}
          onNew={handleNewSession}
          onImport={isGlobal ? undefined : handleOpenImport}
          onDelete={handleDelete}
          onRename={handleRenameSession}
          onDuplicate={handleDuplicate}
          onBatchDelete={handleBatchDelete}
          onDeleteAll={handleDeleteAll}
          onArchive={handleArchive}
          onFavorite={handleFavorite}
          onTogglePin={handleTogglePin}
          sessionPinId={sessionPinIdFor}
          onBatchArchive={handleBatchArchive}
          onMoveToGroup={handleMoveToGroup}
          onBatchMoveToGroup={handleBatchMoveToGroup}
          onCreateGroup={handleCreateGroup}
          onRenameGroup={handleRenameGroup}
          onDeleteGroup={handleDeleteGroup}
          projectName={isGlobal ? t('chat:global.workspaceName') : (projectName ?? '')}
          groupBy={isGlobal ? 'workspace' : 'group'}
        />
        </Panel>}
        {!workbenchSlots && <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors hidden lg:block" />}
        <Panel id="chat-main" order={2} minSize={40} className="min-w-0 relative">
          {/* Collapse/expand the sessions sidebar. */}
          {!workbenchSlots && <button
            onClick={() => {
              // Ação manual assume o controle: limpa o flag de auto-colapso
              // para o observer de largura não brigar (reabrir/re-colapsar).
              autoCollapsedRef.current = false;
              if (sidebarCollapsed) sessionsPanelRef.current?.expand();
              else sessionsPanelRef.current?.collapse();
            }}
            title={sidebarCollapsed ? 'Show sessions' : 'Hide sessions'}
            className="absolute top-1.5 left-1.5 z-20 h-6 w-6 flex items-center justify-center rounded-md bg-card/80 border text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            {sidebarCollapsed ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
          </button>}
          {!selectedId ? (
            <main className="flex h-full w-full min-w-0 bg-[var(--workbench-surface)] overflow-hidden min-h-0">
              <EmptyChatState
                onNew={handleNewSession}
                projectId={projectId}
                projectName={isGlobal ? t('chat:global.workspaceName') : (projectName ?? '')}
                onOpenSidebar={() => setMobileSidebarOpen(true)}
                creating={creatingSession}
              />
            </main>
          ) : (
            <main className="flex h-full w-full min-w-0 bg-[var(--workbench-surface)] overflow-hidden min-h-0 flex-col">
              {sessionData?.session && (
                <ChatHeader
                  session={sessionData.session}
                  streaming={streaming}
                  runDelta={runDelta}
                  lastUsage={lastUsage}
                  stats={stats}
                  contextStatus={contextStatus}
                  indexStatus={indexStatus}
                  // Session insights/configuration live in the right rail —
                  // the header only handles mobile sidebar toggle
                  // and the tokens widget. The activity rail (rendered next
                  // to the right panel) owns those buttons.
                  onOpenDetails={openDetailsPanel}
                  onOpenNotifications={() => setActiveRightPanelId((id) => id === 'notifications' ? null : 'notifications')}
                  unreadNotifications={unreadNotifications}
                  notificationsOpen={activeRightPanelId === 'notifications'}
                  onSummarizeClear={handleSummarizeClear}
                  summarizing={summarizing}
                  onOpenSidebar={openMobileSidebar}
                  pendingSnapshots={snapshotPending}
                  // Builder-style canvas toggle — shown for diagram sessions so
                  // the live draw.io canvas is openable even where the 40px
                  // activity rail is hidden (split/narrow mounts).
                  showCanvasToggle={agent === 'diagram' || (selectedId ? getDiagram(selectedId) != null : false)}
                  canvasActive={activeRightPanelId === 'diagram'}
                  onToggleCanvas={toggleCanvasPanel}
                  // Global sessions: colored per-project chips (focus the file
                  // tree) + a manage button for the virtual workspace.
                  linkedCount={isGlobal ? (sessionData?.linked_projects?.length ?? sessionData?.session.linked_count ?? 0) : undefined}
                  onManageProjects={isGlobal ? () => setManageProjectsOpen(true) : undefined}
                  linkedProjects={isGlobal ? sessionData?.linked_projects : undefined}
                  workspaceProjectId={isGlobal ? sessionData?.session.project_id : undefined}
                  activeProjectId={isGlobal ? activeProjectId : undefined}
                  onFocusProject={isGlobal ? setActiveProjectId : undefined}
                />
              )}
              <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                {selectedId != null && <NotificationBanner sessionId={selectedId} />}
                <ApprovalBanner approvals={pendingApprovals} onRespond={respondToToolApproval} />
                {/* A paused PermissionGate is silence by design — suppress the
                    stall heuristic while approvals are pending. */}
                {pendingApprovals.length === 0 && (
                  <StuckBanner
                    streaming={streaming}
                    lastEventAt={lastEventAt ?? null}
                    onOpenLog={() => setActiveRightPanelId('worker-log')}
                  />
                )}
                <LiveMessageList
                  sessionId={selectedId}
                  sessionData={selectedSessionData}
                  streaming={streaming}
                  preflight={preflight}
                  doneReason={doneReason}
                  error={error}
                  tasksState={tasksState}
                  handlers={handlers}
                  onLoadEarlier={loadEarlierMessages}
                  snapshotActions={selectedId ? snapshotActions : null}
                  snapshotFiles={snapshotFiles}
                  onClearCurrentTurn={clearCurrentTurn}
                  onTaskToolCompleted={handleTaskToolCompleted}
                />
              </div>
              <div className="relative">
              <IndexingOverlay projectId={projectIndexId} />
              <ProviderSelectionNotice state={providerChange} onRetry={retryProviderChange} />
              <Composer
                    sessionCollaboration
                ref={composerRef}
                filePicks={filePicks}
                onRemovePick={togglePick}
                onClearPicks={clearPicks}
                agent={agent}
                setAgent={handleAgentChange}
                hideAgentPicker={hideAgentPicker}
                provider={provider}
                model={model}
                setModel={setModel}
                onSwitchProvider={handleSwitchProvider}
                onSend={handleSend}
                onAbort={abort}
                streaming={streaming}
                providerOptions={providerOptions}
                currentProviderModels={currentProviderModels}
                maxTurns={maxTurns}
                setMaxTurns={handleMaxTurnsChange}
                maxAutoContinues={maxAutoContinues}
                setMaxAutoContinues={handleMaxAutoContinuesChange}
                sessionId={selectedId}
                thinking={thinking}
                setThinking={handleThinkingChange}
                supportsThinking={providerSupportsThinking(provider, providerOptions, model)}
                ultraControlsThinking={ultraControlsThinking}
                describeImages={describeImages}
                setDescribeImages={setDescribeImages}
                blockCodeComments={blockCodeComments}
                setBlockCodeComments={handleBlockCodeCommentsChange}
                fallbackProvider={fallbackProvider}
                fallbackModel={fallbackModel}
                onFallbackChange={handleFallbackChange}
                temperature={sessionTemperature}
                setTemperature={handleTemperatureChange}
                reasoningEffort={reasoningEffort}
                setReasoningEffort={handleReasoningEffortChange}
                reasoningLevels={reasoningLevels}
                executionMode={executionMode}
                setExecutionMode={handleExecutionModeChange}
                executionModePending={executionModePending}
                executionModeLocked={executionModeLocked}
                sendBlocked={executionModePending || providerChange?.pending || Boolean(providerChange?.error)}
                planDepth={planDepth}
                setPlanDepth={handlePlanDepthChange}
                responseLanguage={responseLanguage}
                setResponseLanguage={handleResponseLanguageChange}
                outputStyle={outputStyle}
                setOutputStyle={handleOutputStyleChange}
                outputCapLevel={outputCapLevel}
                setOutputCapLevel={handleOutputCapLevelChange}
                toolPermissionMode={toolPermissionMode}
                setToolPermissionMode={handleToolPermissionModeChange}
                getModelsForProvider={getModelsForProvider}
                queueable={!!selectedId}
                onQueue={handleQueue}
                queuedStrip={queuedStrip}
              />
              </div>
            </main>
          )}
        </Panel>
        {!workbenchSlots && selectedId && activeRightPanelId && (
          <>
            {/* The diagram canvas escapes the `lg` viewport gate: the chat is
                effectively <1024px in split mounts (ProjectView preview split,
                editor copilot rail), where the builder-style canvas is most
                wanted — gating it there left it display:none after auto-open.
                Other (narrow tool-window) panels keep the gate. */}
            <PanelResizeHandle
              className={`w-px bg-border hover:bg-primary/40 transition-colors ${
                activeRightPanelId === 'diagram' ? 'block' : 'hidden lg:block'
              }`}
            />
            <Panel
              id="right-panel"
              order={3}
              defaultSize={activeRightPanelId === 'diagram' ? 52 : 22}
              minSize={activeRightPanelId === 'diagram' ? 32 : 16}
              maxSize={activeRightPanelId === 'diagram' ? 72 : 38}
              collapsible
              className={activeRightPanelId === 'diagram' ? 'block min-w-0' : 'hidden lg:block min-w-0'}
            >
              <RightPanelHost
                activeId={activeRightPanelId}
                onSelectPanel={setActiveRightPanelId}
                sessionId={selectedId}
                session={sessionData?.session ?? null}
                sessionData={sessionData ?? null}
                stats={stats}
                projectId={(isGlobal ? activeProjectId : projectId) ?? null}
                refreshKey={stateRefreshKey + sidebarRefreshTick}
                todos={todos}
                filePicks={filePicks}
                onTogglePick={togglePick}
                onSetManyPicks={setManyPicks}
                onClearPicks={clearPicks}
                activeProcesses={activeProcesses}
                pluginWindows={pluginPanelWindows}
                preview={preview}
                onClose={() => setActiveRightPanelId(null)}
              />
            </Panel>
          </>
        )}
        </PanelGroup>
        {/* Activity rail — fixed 40px, sits flush right when a session is
            open. Hidden on mobile (where the sidebar drawer already
            provides navigation, and 40px would crowd the chat). */}
        {!workbenchSlots && selectedId && (
          <div className="hidden lg:block">
            <ChatRightRail
              sessionId={selectedId}
              activePanelId={activeRightPanelId}
              onSelectPanel={setActiveRightPanelId}
              onOpenSnapshots={openSnapshots}
              pendingSnapshots={snapshotPending}
              sessionData={sessionData ?? null}
              pluginWindows={pluginPanelWindows}
              previewAvailable={previewAvailable}
            />
          </div>
        )}
        </div>
      </div>
      {workbenchSlots?.sessionsHost && createPortal(
        <SessionSidebar
          docked
          actionsHost={sessionActionsHost}
          scopeKey={String(projectId) + ':' + (worktrees.path ?? '')}
          newDisabled={worktrees.unavailable}
          sessions={worktrees.visible ?? null}
          groups={groups ?? null}
          view={view}
          onViewChange={handleViewChange}
          selectedId={selectedId}
          creating={creatingSession}
          onSelect={handleSelectSession}
          mobileOpen={mobileSidebarOpen}
          onMobileClose={closeMobileSidebar}
          onNew={handleNewSession}
          onImport={isGlobal ? undefined : handleOpenImport}
          onDelete={handleDelete}
          onRename={handleRenameSession}
          onDuplicate={handleDuplicate}
          onBatchDelete={handleBatchDelete}
          onDeleteAll={handleDeleteAll}
          onArchive={handleArchive}
          onFavorite={handleFavorite}
          onTogglePin={handleTogglePin}
          sessionPinId={sessionPinIdFor}
          onBatchArchive={handleBatchArchive}
          onMoveToGroup={handleMoveToGroup}
          onBatchMoveToGroup={handleBatchMoveToGroup}
          onCreateGroup={handleCreateGroup}
          onRenameGroup={handleRenameGroup}
          onDeleteGroup={handleDeleteGroup}
          projectName={isGlobal ? t('chat:global.workspaceName') : (projectName ?? '')}
          groupBy={isGlobal ? 'workspace' : 'group'}
        />,
        workbenchSlots.sessionsHost,
      )}
      {workbenchSlots?.rightPanelHost && selectedId && activeRightPanelId && createPortal(
        <RightPanelHost
          activeId={activeRightPanelId}
          onSelectPanel={setActiveRightPanelId}
          sessionId={selectedId}
          session={sessionData?.session ?? null}
          sessionData={sessionData ?? null}
          stats={stats}
          projectId={(isGlobal ? activeProjectId : projectId) ?? null}
          refreshKey={stateRefreshKey + sidebarRefreshTick}
          todos={todos}
          filePicks={filePicks}
          onTogglePick={togglePick}
          onSetManyPicks={setManyPicks}
          onClearPicks={clearPicks}
          activeProcesses={activeProcesses}
          pluginWindows={pluginPanelWindows}
          preview={preview}
          onClose={() => setActiveRightPanelId(null)}
        />,
        workbenchSlots.rightPanelHost,
      )}
      {workbenchSlots?.rightRailHost && selectedId && createPortal(
        <ChatRightRail
          sessionId={selectedId}
          activePanelId={activeRightPanelId}
          onSelectPanel={setActiveRightPanelId}
          onOpenSnapshots={openSnapshots}
          pendingSnapshots={snapshotPending}
          sessionData={sessionData ?? null}
          pluginWindows={pluginPanelWindows}
          previewAvailable={previewAvailable}
        />,
        workbenchSlots.rightRailHost,
      )}
      {selectedId != null && (
        <Dialog open={snapshotsOpen} onOpenChange={setSnapshotsOpen}>
          <DialogContent
            className="p-0 gap-0 max-w-[100vw] sm:max-w-[1500px] w-[100vw] sm:w-[96vw] h-[100dvh] sm:h-[92dvh] sm:max-h-[92dvh] rounded-none sm:rounded-xl overflow-hidden flex flex-col"
          >
            <DialogHeader className="sr-only">
              <DialogTitle>{t('projects:snapshotPanel.dialogTitle')}</DialogTitle>
              <DialogDescription>{t('projects:snapshotPanel.dialogDescription')}</DialogDescription>
            </DialogHeader>
            <div className="flex-1 min-h-0">
              {/* Radix only renders DialogContent while open, so the chunk is
                  fetched on the first open of the snapshots review. */}
              <Suspense
                fallback={(
                  <div className="grid h-full place-items-center" aria-busy="true">
                    <span className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
                  </div>
                )}
              >
                <SnapshotsPanel
                  scope="coder"
                  sessionId={selectedId}
                  refreshKey={snapshotTick}
                  initialBaselineId={snapshotInitialBaselineId}
                  onSubmitReviewMessage={handleSnapshotReviewMessage}
                  dialogMode
                />
              </Suspense>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
