import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useIndexBusy } from '../workspace/jetbrains/status-bar/useIndexStatus.js';
import { IndexingOverlay } from './IndexingOverlay.js';
import { useTranslation } from 'react-i18next';
import { useAgentStream } from '../../hooks/useAgentStream.js';
import { usePipelineStream } from '../../hooks/usePipelineStream.js';
import { apiDelete, apiPatch, apiPost, useApi } from '../../hooks/useApi.js';
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
import { ChatRightRail } from './right-panel/ChatRightRail.js';
import { RightPanelHost } from './right-panel/RightPanelHost.js';
import { usePluginPanels } from './right-panel/usePluginPanels.js';
import { setDiagramXml, getDiagram } from './right-panel/diagram/diagram-store.js';
import type { RightPanelId } from './right-panel/types.js';
import { Composer, type ComposerHandle } from './composer/Composer.js';
import { levelFromSession, type OutputCapLevel } from './composer/output-cap-levels.js';
import { useMessageQueue, type QueueDeliver, type QueueMode } from './composer/useMessageQueue.js';
import { QueuedMessages } from './composer/QueuedMessages.js';
import { providerSupportsThinking, resolveReasoningLevels } from './composer/provider-caps.js';
import { PROVIDERS } from './constants.js';
import { EmptyChatState } from './EmptyChatState.js';
import { MessageList } from './messages/MessageList.js';
import { StuckBanner } from './StuckBanner.js';
import { ApprovalBanner } from './ApprovalBanner.js';
import { NotificationBanner } from './notifications/NotificationBanner.js';
import { useUnreadNotificationCount } from './notifications/session-notifications-store.js';
// The five ex-modals (Skills/Tools/Metrics/ToolStats/Details) and the
// WorkerLog/SessionState panels are now routed through `RightPanelHost`
// — only Snapshots stays as a true Dialog because its diff viewer needs
// the full viewport width.
import { SessionSidebar, type SessionView } from './SessionSidebar.js';
import { GlobalNewSessionDialog } from './global/GlobalNewSessionDialog.js';
import { ManageGlobalProjectsDialog } from './global/ManageGlobalProjectsDialog.js';
import { SnapshotsPanel } from '../snapshots/SnapshotsPanel.js';
import { fetchSnapshotList } from '../snapshots/api.js';
import type {
  AgentChatProps,
  CoderSession,
  CoderSessionGroup,
  MessagePage,
  PromptHandlers,
  SessionData,
} from './types.js';
import { useAgentChatState } from './useAgentChatState.js';
import { consumePendingAttachments, consumeSelectionPrefix, onStudioSend, usePublishAgentBusy } from '../builder/studio/studio-context-store.js';
import type { AgentAttachment } from '../../hooks/useAgentStream.js';
import type { NotificationSourceContext } from '../notifications/index.js';
import { markRouteEvent } from '../../lib/perf/route-startup-metrics.js';

export default function AgentChat({ projectId, projectName, mode = 'project', initialSessionId, selectionPrefixSessionId }: AgentChatProps) {
  const { t } = useTranslation(['chat', 'common']);
  const confirm = useConfirm();
  // Global (multi-project) mode: the session list is cross-project (no
  // project_id filter), groups are disabled, and new sessions go through the
  // project multi-select dialog. Default 'project' keeps every existing mount
  // byte-identical.
  const isGlobal = mode === 'global';
  useEffect(() => {
    markRouteEvent('AgentChat:mounted', { projectId, tab: 'chat', mode });
  }, [mode, projectId]);
  const [view, setView] = useState<SessionView>('active');
  const { data: sessions, refetch: refetchSessions } = useApi<CoderSession[]>(
    isGlobal
      ? `/coder/sessions/global?archived=${view === 'archived' ? '1' : '0'}`
      : `/coder/sessions?project_id=${projectId}&archived=${view === 'archived' ? '1' : '0'}`,
  );
  const { data: groups, refetch: refetchGroups } = useApi<CoderSessionGroup[]>(
    // Groups are per-project; disabled in global mode ('' → useApi skips the fetch).
    isGlobal ? '' : `/coder/groups?project_id=${projectId}`,
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Global mode: which linked project the right-rail file tree is rooted at.
  // Defaults to the selected session's primary; reset when the session changes.
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [provider, setProvider] = useState('zai');
  const [model, setModel] = useState('');
  const [agent, setAgent] = useState<'explore' | 'plan' | 'build' | 'admin' | 'spec' | 'api' | 'diagram'>('explore');

  // SSE-driven agent transitions (Plan→Build after submit_plan approval,
  // Spec→Build after submit_spec, manual server-side switches). Backend
  // emits `session_agent_changed` via the runner bus; the stream handler
  // (`hooks/agent-stream/handlers.ts`) bridges to this DOM CustomEvent.
  // Replaces the polling refetch fallback in onPlanResponse / onSpecResponse
  // (which stays as a belt-and-suspenders safety net for slow or dropped
  // SSE deliveries).
  useEffect(() => {
    const onAgentChanged = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { sessionId?: number; agent?: string };
      if (!detail || detail.sessionId !== selectedId) return;
      const next = detail.agent;
      if (
        next
        && next !== agent
        && (next === 'explore' || next === 'plan' || next === 'build' || next === 'admin' || next === 'spec' || next === 'api' || next === 'diagram')
      ) {
        setAgent(next);
      }
    };
    window.addEventListener('coder:session_agent_changed', onAgentChanged);
    return () => window.removeEventListener('coder:session_agent_changed', onAgentChanged);
  }, [agent, selectedId]);

  // Live diagram updates: the draw.io agent's diagram_create/update emits
  // `diagram_changed` over SSE (bridged to a DOM event by handlers.ts). Feed
  // the session-keyed store so the embedded editor renders the new XML, and
  // auto-open the wide Diagram panel the FIRST time per session (subsequent
  // edits update in place without stealing focus).
  const autoOpenedDiagram = useRef<Set<number>>(new Set());
  useEffect(() => {
    const onDiagramChanged = (e: Event): void => {
      const d = (e as CustomEvent).detail as { sessionId?: number; path?: string; xml?: string };
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
  const [fallbackProvider, setFallbackProvider] = useState<string | null>(null);
  const [fallbackModel, setFallbackModel] = useState<string | null>(null);
  const [sessionTemperature, setSessionTemperature] = useState<number | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [planDepth, setPlanDepth] = useState<string | null>(null);
  const [outputCapLevel, setOutputCapLevel] = useState<OutputCapLevel>('economic');
  const [toolPermissionMode, setToolPermissionMode] = useState<'ask' | 'auto' | 'unrestricted'>('auto');
  const [summarizing, setSummarizing] = useState<boolean>(false);
  const composerRef = useRef<ComposerHandle>(null);
  const sessionsPanelRef = useRef<ImperativePanelHandle>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const pendingAutoTitle = useRef<Set<number>>(new Set());
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState('');
  // Global mode: the multi-project create dialog (project multi-select).
  const [globalNewOpen, setGlobalNewOpen] = useState(false);
  // Global mode: the "manage workspace projects" dialog (attach/remove after create).
  const [manageProjectsOpen, setManageProjectsOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [renameGroupTarget, setRenameGroupTarget] = useState<CoderSessionGroup | null>(null);
  const [renameGroupName, setRenameGroupName] = useState('');
  const [renameSessionTarget, setRenameSessionTarget] = useState<{ id: number; title: string } | null>(null);
  const [renameSessionTitle, setRenameSessionTitle] = useState('');
  // Snapshots is the only surface that stays as a modal — its content
  // (file diff viewer) needs the full viewport width. The other five
  // ex-modals (skills, tools, metrics, tool-stats, details) live in the
  // right rail now and are switched via `activeRightPanelId`.
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [snapshotPending, setSnapshotPending] = useState(0);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  /**
   * Single active right-rail panel id. Replaces the boolean pair
   * `metaSidebarOpen` + `workerLogOpen` and the four modal-open flags
   * (skillConfig/toolConfig/metrics/toolStats/details). `null` collapses
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
    return saved as RightPanelId;
  });
  useEffect(() => {
    localStorage.setItem('chatRightPanelId', activeRightPanelId ?? 'null');
  }, [activeRightPanelId]);
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
  /** PR-4: when set, the Composer's send button flips to "Run pipeline". */
  const [selectedPipelineId, setSelectedPipelineId] = useState<number | null>(null);

  const sessionUrl = selectedId ? `/coder/sessions/${selectedId}?tail=120` : '';
  const { data: sessionData, refetch: refetchSession, update: updateSessionData } = useApi<SessionData>(sessionUrl);

  // Composer gate: block sending while the session's project is ACTIVELY indexing
  // (the freshly-created global union's first pass). Once `structural_ready` the
  // agent can search/symbol, so we only block the two in-progress phases — never
  // 'none' (which would deadlock the composer if auto-index is off). Inert for a
  // normal already-indexed project (phase ready) and guarded on selectedId.
  const projectIndexId = sessionData?.session.project_id ?? 0;
  // Boolean selector: re-renders this heavy tree only when the busy flag flips,
  // NOT on every progress frame. The live progress text lives in the isolated
  // <IndexingOverlay> leaf so the per-frame stream can't drive a full re-render.
  const indexBusy = useIndexBusy(projectIndexId);
  const indexing = !!selectedId && indexBusy;

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
      sessionData?.session.title
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
  }, [isGlobal, projectId, projectName, selectedId, sessionData?.session.title, sessions]);

  const stream = useAgentStream(selectedId, notificationContext);
  const { pipelineRuntime, openStream: openPipelineStream } = usePipelineStream(selectedId, notificationContext);
  const {
    streaming,
    currentTurn,
    doneReason,
    error,
    lastUsage,
    runDelta,
    todos,
    contextStatus,
    indexStatus,
    sidebarRefreshTick,
    tasksRefreshTick,
    snapshotTick,
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
    switchProvider,
  } = stream;

  const unreadNotifications = useUnreadNotificationCount(selectedId ?? 0);

  // Builder/DS studio: gate the preview's auto-fix loop while this chat runs.
  usePublishAgentBusy(selectionPrefixSessionId, streaming);

  const { providerOptions, currentProviderModels, getModelsForProvider, tasksState, stats, liveTurnDuplicatedInHistory, persistedToolUseIds } =
    useAgentChatState({
      selectedId,
      doneReason,
      tasksRefreshTick,
      sessionData: sessionData ?? null,
      currentTurn,
      provider,
      model,
      setProvider,
      setModel,
    });

  // Pending-snapshot count — refetched on selection change and whenever the
  // SSE stream pings `session_snapshot_changed`. Used as a badge on the
  // Snapshots button in the chat header.
  useEffect(() => {
    if (!selectedId) {
      setSnapshotPending(0);
      return;
    }
    let cancelled = false;
    fetchSnapshotList('coder', selectedId)
      .then((r) => {
        if (cancelled) return;
        const pending = r.files
          .filter((f) => f.status === 'active')
          .reduce((acc, f) => acc + (f.pendingHunks || (f.hunkCount === 0 ? 1 : 0)), 0);
        setSnapshotPending(pending);
      })
      .catch(() => {
        if (!cancelled) setSnapshotPending(0);
      });
    return () => {
      cancelled = true;
    };
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
        clearCurrentTurn();
        window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doneReason, selectedId, refetchSession, refetchSessions, clearCurrentTurn]);

  const persistedMessageCount = sessionData?.messages.length ?? 0;
  useEffect(() => {
    if ((!streaming && currentTurn && persistedMessageCount > 0) || liveTurnDuplicatedInHistory) {
      clearCurrentTurn();
    }
  }, [persistedMessageCount, streaming, currentTurn, clearCurrentTurn, liveTurnDuplicatedInHistory]);

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

  // Goal/tasks state lives in DB and the sidebar reads it via a separate
  // /state-summary fetch. End-of-turn refresh isn't enough — a long turn that
  // creates a goal and runs many tasks would leave the sidebar stale until it
  // ends. So also bump the key whenever a goal/tasks-related tool finishes
  // mid-stream. We track completion count and bump when it grows.
  const goalToolDoneCountRef = useRef(0);
  useEffect(() => {
    if (!currentTurn) {
      goalToolDoneCountRef.current = 0;
      return;
    }
    const goalToolNames = new Set([
      'create_goal',
      'update_goal',
      'get_goal',
      'task_list',
      'todo_write',
      'update_todo',
      'submit_tasks',
      'list_tasks',
      'cancel_tasks',
      'delete_tasks',
      'archive_task_list',
      'execute_tasks',
      'execute_task',
      'task_complete',
      'update_task',
      'approve_subordinate_tasks',
      'submit_tasks_to_master',
    ]);
    let count = 0;
    for (const b of currentTurn.blocks) {
      if (b.type !== 'tool') continue;
      if (b.call.status !== 'done') continue;
      if (goalToolNames.has(b.call.name)) count += 1;
    }
    if (count > goalToolDoneCountRef.current) {
      goalToolDoneCountRef.current = count;
      setStateRefreshKey((k) => k + 1);
    }
  }, [currentTurn]);

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

  // Skill picks: skill ids selected in SkillsSection. The server expands them
  // into an `<active_skills>` block prepended to the user message so the agent
  // does not need to discover or load the skill content via tool calls first.
  const [skillPicks, setSkillPicks] = useState<string[]>([]);
  const toggleSkillPick = useCallback((id: string) => {
    setSkillPicks((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);
  const clearSkillPicks = useCallback(() => setSkillPicks([]), []);

  // Reset picks when switching sessions.
  useEffect(() => {
    setFilePicks([]);
    setSkillPicks([]);
  }, [selectedId]);

  const createSession = useCallback(async (title?: string) => {
    const created = await apiPost<CoderSession>('/coder/sessions', {
      project_id: projectId,
      title: (title ?? 'Nova sessão').slice(0, 80),
      provider,
      model: model || PROVIDERS.find((p) => p.id === provider)?.defaultModel,
    });
    if (!title) pendingAutoTitle.current.add(created.id);
    refetchSessions();
    setSelectedId(created.id);
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
    return created;
  }, [projectId, provider, model, refetchSessions]);

  const createGlobalSession = async (opts: { title?: string; projectIds?: number[]; primaryProjectId?: number; reuseProjectId?: number }) => {
    const created = await apiPost<CoderSession>('/coder/sessions/global', {
      ...(opts.reuseProjectId
        ? { reuse_project_id: opts.reuseProjectId }
        : { project_ids: opts.projectIds, primary_project_id: opts.primaryProjectId }),
      title: (opts.title ?? 'Nova sessão global').slice(0, 80),
      provider,
      model: model || PROVIDERS.find((p) => p.id === provider)?.defaultModel,
    });
    if (!opts.title) pendingAutoTitle.current.add(created.id);
    refetchSessions();
    setSelectedId(created.id);
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
    return created;
  };

  const handleNewSession = useCallback(() => {
    // Global mode opens the project multi-select dialog instead of an
    // immediate single-project create.
    if (isGlobal) {
      setGlobalNewOpen(true);
      return;
    }
    void createSession();
  }, [isGlobal, createSession]);

  const confirmNewSession = async () => {
    const title = newSessionTitle.trim();
    setNewSessionOpen(false);
    await createSession(title || undefined);
  };

  const handleSend = useCallback(async (text: string, atts: AgentAttachment[], selectedSkillIds?: string[]) => {
    if (!text.trim() || !selectedId) return;
    // Block sending while the project is still indexing — covers BOTH the click
    // path and the Cmd/Ctrl+Enter keyboard path (the overlay only blocks mouse).
    if (indexing) return;
    const shouldAutoTitle = pendingAutoTitle.current.has(selectedId);
    if (shouldAutoTitle) pendingAutoTitle.current.delete(selectedId);
    // Builder studio: prepend the selected-element block(s) and drain any
    // region-select screenshot(s) into the attachments (then clear both).
    const prefix = selectionPrefixSessionId ? consumeSelectionPrefix(selectionPrefixSessionId) : '';
    const shots = selectionPrefixSessionId ? consumePendingAttachments(selectionPrefixSessionId) : [];
    const outgoing = prefix ? `${prefix}\n${text}` : text;
    const allAtts = shots.length ? [...atts, ...shots] : atts;
    await sendMessage(outgoing, async () => {
      refetchSession();
      if (shouldAutoTitle) {
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
    }, { attachments: allAtts, agent, maxTurns, thinking, describeImages, selectedSkillIds, freshSession: persistedMessageCount === 0 });
  }, [selectedId, indexing, sendMessage, refetchSession, refetchSessions, agent, maxTurns, thinking, describeImages, selectionPrefixSessionId, persistedMessageCount]);

  // ─── Message queue (compose/enqueue while streaming) ───────────────
  // Delivery is run-state-aware and serves BOTH queue modes:
  //   • live run  → POST /inject (JSON, NO new stream): enqueues into the live
  //     runner; the already-open SSE renders the agent's next turn. Calling
  //     sendMessage here would open a 2nd stream that aborts the live one and
  //     wipes the in-flight turn (the freeze bug) — so we never do that mid-run.
  //   • no run    → /inject returns { noActiveRun }; fall back to sendMessage,
  //     which opens a fresh streamed run (the end-of-session path).
  const deliverQueued = useCallback<QueueDeliver>(async (text, { interject, skillIds }) => {
    if (!selectedId) return;
    try {
      const r = await apiPost<{ injected?: boolean; noActiveRun?: boolean; waiting?: boolean }>(
        `/coder/sessions/${selectedId}/inject`,
        { content: text, interject, selected_skill_ids: skillIds },
      );
      if (r?.injected) { refetchSession(); return; }
    } catch { /* fall through to a fresh streamed send */ }
    await sendMessage(text, async () => { refetchSession(); }, {
      agent, maxTurns, thinking, describeImages, selectedSkillIds: skillIds, interject,
    });
  }, [selectedId, sendMessage, refetchSession, agent, maxTurns, thinking, describeImages]);
  const queue = useMessageQueue({ streaming, deliver: deliverQueued });
  const handleQueue = useCallback((text: string, mode: QueueMode, skillIds?: string[]) => {
    if (!selectedId) return;
    const prefix = selectionPrefixSessionId ? consumeSelectionPrefix(selectionPrefixSessionId) : '';
    // Region screenshots can't ride the queue (the /inject path has no attachment
    // channel), so DRAIN + DISCARD them here instead of letting them silently
    // attach to a LATER immediate send. Refs (text) still go with the queued
    // message via the prefix above. (Full carry-through would need attachments
    // threaded through useMessageQueue + /inject.)
    if (selectionPrefixSessionId) consumePendingAttachments(selectionPrefixSessionId);
    queue.enqueue(prefix ? `${prefix}\n${text}` : text, mode, skillIds);
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
    await sendMessage(message, async () => {
      refetchSession();
    }, { agent: reviewAgent, maxTurns, thinking, describeImages });
  }, [selectedId, sendMessage, refetchSession, agent, maxTurns, thinking, describeImages]);

  /**
   * Pipeline-mode send: post to `/pipelines/:pid/start` instead of
   * /messages. Pipeline events arrive over a separate SSE stream — see
   * `usePipelineStream` consumed by the SessionStateSidebar.
   */
  const handleRunPipeline = useCallback(async (pipelineId: number, initialInput: string) => {
    if (!selectedId) return;
    try {
      await apiPost(`/coder/sessions/${selectedId}/pipelines/${pipelineId}/start`, {
        initial_input: initialInput,
      });
      // Now that the executor is registered server-side, open the SSE.
      // The hook stays closed until this call to avoid the 404-retry loop.
      openPipelineStream();
    } catch (err) {
      console.warn('[pipeline] start failed:', err);
    }
  }, [selectedId, openPipelineStream]);


  /**
   * Load earlier messages from the backend and prepend them to sessionData.
   * Called by MessageList when the user clicks "Load earlier".
   * Returns the number of message rows fetched (0 = nothing more to load).
   */
  const loadEarlierMessages = useCallback(async (beforeId: number, limit = 40, includeArchived = false): Promise<number> => {
    if (!selectedId) return 0;
    try {
      const archivedQs = includeArchived ? '&include_archived=1' : '';
      const res = await fetch(`/api/coder/sessions/${selectedId}/messages?before_id=${beforeId}&limit=${limit}${archivedQs}`);
      if (!res.ok) return 0;
      const page = (await res.json()) as MessagePage;
      if (!page.message_rows.length) return 0;
      updateSessionData((prev) => ({
        ...prev,
        messages: [...page.messages, ...prev.messages],
        message_rows: [...page.message_rows, ...prev.message_rows],
        tool_results: [...(page.tool_results ?? []), ...(prev.tool_results ?? [])],
      }));
      return page.message_rows.length;
    } catch {
      return 0;
    }
  }, [selectedId, updateSessionData]);

  // Mirror sessionData into a ref so handleSwitchProvider can read its current
  // value in the guard WITHOUT listing `sessionData` (which changes on every
  // refetch) as a dep — that would re-create the callback constantly and defeat
  // the <Composer> memo. `streaming` stays a real dep (it's also a Composer prop,
  // so a flip re-renders the composer regardless).
  const sessionDataRef = useRef(sessionData);
  sessionDataRef.current = sessionData;
  const handleSwitchProvider = useCallback(async (newProvider: string, newModel: string) => {
    setProvider(newProvider);
    setModel(newModel);
    if (selectedId && (streaming || sessionDataRef.current)) {
      await switchProvider(newProvider, newModel || undefined);
      refetchSession();
      refetchSessions();
    }
  }, [selectedId, streaming, switchProvider, refetchSession, refetchSessions]);

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

  // Reasoning-effort override (migration 150). Same read pattern as temperature —
  // the column flows through the full session payload. Orthogonal to thinking.
  useEffect(() => {
    if (!sessionData?.session) {
      setReasoningEffort(null);
      return;
    }
    const e = sessionData.session.reasoning_effort_override;
    setReasoningEffort(typeof e === 'string' && e.length > 0 ? e : null);
  }, [sessionData?.session]);

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

  // Agent/mode hydration. Keyed on the session ID (NOT the session object) so
  // an end-of-run refetch — same id, new object — never clobbers a manual
  // dropdown pick made mid-session; only a session switch / first load
  // re-hydrates. Live transitions (plan→build) arrive via the
  // `coder:session_agent_changed` handler above (disjoint trigger). 'builder'
  // sessions aren't selectable in this composer, so they're left untouched.
  useEffect(() => {
    const a = sessionData?.session?.agent;
    if (a && (a === 'explore' || a === 'plan' || a === 'build' || a === 'admin' || a === 'spec' || a === 'api' || a === 'diagram')) {
      setAgent(a);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionData?.session?.id]);

  // Persist a manual dropdown pick immediately so leaving WITHOUT sending still
  // remembers it. Applies to the NEXT run (agent identity is baked into the
  // runner at construction; mid-run transitions are runner-driven).
  const handleAgentChange = useCallback((next: 'explore' | 'plan' | 'build' | 'admin' | 'spec' | 'api' | 'diagram') => {
    setAgent(next);
    if (selectedId) apiPatch(`/coder/sessions/${selectedId}/agent`, { agent: next }).catch(() => {});
  }, [selectedId]);

  const handleTemperatureChange = useCallback(async (next: number | null) => {
    setSessionTemperature(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/temperature`, { temperature: next });
    } catch {
      /* ignore — UI optimistic, server is the source of truth on next refetch */
    }
  }, [selectedId]);

  const handleReasoningEffortChange = useCallback(async (next: string | null) => {
    setReasoningEffort(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/reasoning-effort`, { effort: next });
    } catch {
      /* ignore — UI optimistic, server is the source of truth on next refetch */
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

  const handleDelete = useCallback(async (id: number) => {
    const ok = await confirm({
      title: t('chat:deleteSession'),
      description: t('chat:deleteSessionDescription'),
      variant: 'destructive',
      confirmLabel: t('common:actions.delete'),
    });
    if (!ok) return;
    await apiDelete(`/coder/sessions/${id}`);
    if (selectedId === id) setSelectedId(null);
    refetchSessions();
  }, [confirm, t, selectedId, refetchSessions]);

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

  const handleBatchDelete = useCallback(async (ids: number[]) => {
    if (ids.length === 0) return;
    const ok = await confirm({
      title: t('chat:deleteSessions', { count: ids.length }),
      description: t('chat:deleteSessionsDescription'),
      variant: 'destructive',
      confirmLabel: t('common:actions.delete'),
    });
    if (!ok) return;
    await apiPost('/coder/sessions/batch-delete', { ids });
    if (selectedId != null && ids.includes(selectedId)) setSelectedId(null);
    refetchSessions();
  }, [confirm, t, selectedId, refetchSessions]);

  const handleDeleteAll = useCallback(async () => {
    const ids = (sessions ?? []).map((s) => s.id);
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
    await apiPost('/coder/sessions/batch-delete', { ids });
    if (selectedId != null && ids.includes(selectedId)) setSelectedId(null);
    refetchSessions();
  }, [sessions, confirm, t, view, selectedId, refetchSessions]);

  const handleArchive = useCallback(async (id: number, archived: boolean) => {
    await apiPatch(`/coder/sessions/${id}/archive`, { archived });
    // Session leaves the current view — drop selection.
    if (selectedId === id) setSelectedId(null);
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [selectedId, refetchSessions]);

  const handleFavorite = useCallback(async (id: number, favorite: boolean) => {
    await apiPatch(`/coder/sessions/${id}/favorite`, { favorite });
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [refetchSessions]);

  const handleRenameSession = useCallback((id: number, currentTitle: string) => {
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

  const handleDuplicate = useCallback(async (id: number) => {
    const res = await apiPost<{ session: CoderSession }>(`/coder/sessions/${id}/duplicate`, {});
    await refetchSessions();
    setSelectedId(res.session.id);
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [refetchSessions]);

  const handleFork = async (messageId: number) => {
    if (!selectedId) return;
    const res = await apiPost<{ session: CoderSession; seed_text: string }>(
      `/coder/sessions/${selectedId}/fork`,
      { before_message_id: messageId },
    );
    await refetchSessions();
    setSelectedId(res.session.id);
    composerRef.current?.setInput(res.seed_text);
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  };

  // Rollback: destructively truncate THIS session at the message, then drop its
  // text + attachments back into the composer for editing & re-sending.
  const handleRollback = async (messageId: number) => {
    if (!selectedId) return;
    const ok = await confirm({
      title: t('chat:rollbackConfirmTitle'),
      description: t('chat:rollbackConfirmDescription'),
      variant: 'destructive',
      confirmLabel: t('chat:rollbackConfirmLabel'),
    });
    if (!ok) return;
    // The backend rejects with 409 when a run is active (and 400 on a stale
    // message id). Surface that instead of swallowing it into a silent no-op —
    // the destructive delete either fully succeeds or fully fails server-side.
    try {
      const res = await apiPost<{ seed_text: string; seed_attachments: AgentAttachment[] }>(
        `/coder/sessions/${selectedId}/rollback-to-message`,
        { message_id: messageId },
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
    }
  };

  const handleBatchArchive = useCallback(async (ids: number[], archived: boolean) => {
    await Promise.all(ids.map((id) => apiPatch(`/coder/sessions/${id}/archive`, { archived })));
    if (selectedId != null && ids.includes(selectedId)) setSelectedId(null);
    refetchSessions();
  }, [selectedId, refetchSessions]);

  const handleMoveToGroup = useCallback(async (id: number, groupId: number | null) => {
    await apiPatch(`/coder/sessions/${id}/group`, { group_id: groupId });
    refetchSessions();
  }, [refetchSessions]);

  const handleBatchMoveToGroup = useCallback(async (ids: number[], groupId: number | null) => {
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
    await apiPatch(`/coder/groups/${renameGroupTarget.id}`, { name });
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
    await apiDelete(`/coder/groups/${group.id}`);
    refetchGroups();
    refetchSessions();
  }, [confirm, t, refetchGroups, refetchSessions]);

  // Stable handlers reference so the memoized <PersistedMessages /> inside
  // MessageList doesn't re-render on every parent render. Deps are the three
  // useCallback-stable functions from useAgentStream.
  const handlers: PromptHandlers = useMemo(
    () => ({
      onAnswer: (answer) => answerQuestion(answer),
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
              if (
                s.agent
                && s.agent !== agent
                && (s.agent === 'explore' || s.agent === 'plan' || s.agent === 'build' || s.agent === 'admin' || s.agent === 'spec' || s.agent === 'api')
              ) {
                setAgent(s.agent);
              }
            }
          } catch {
            /* non-fatal: AgentPicker just keeps the stale value */
          }
        }
      },
      onTasksResponse: (verdict) => respondToTasks(verdict),
      onDecide: (answers) => decideGate(answers),
      onSpecResponse: async (approved, spec_path, requested_changes) => {
        await respondToSpec(approved, spec_path, requested_changes);
        // After approval the backend transitions agent 'spec' → 'build'. Refresh
        // the local agent state so the picker reflects the new mode.
        if (approved && selectedId) {
          try {
            const r = await fetch(`/api/coder/sessions/${selectedId}`);
            if (r.ok) {
              const s = (await r.json()) as { agent?: string };
              if (
                s.agent
                && s.agent !== agent
                && (s.agent === 'explore' || s.agent === 'plan' || s.agent === 'build' || s.agent === 'admin' || s.agent === 'spec' || s.agent === 'api')
              ) {
                setAgent(s.agent);
              }
            }
          } catch {
            /* non-fatal */
          }
        }
      },
      onFork: handleFork,
      onRollback: handleRollback,
      onToolApproval: (toolUseId, verdict) => respondToToolApproval(toolUseId, verdict),
    }),
    // handleFork / handleRollback depend on selectedId — re-create on switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [answerQuestion, respondToPlan, decideGate, respondToTasks, respondToSpec, respondToToolApproval, selectedId, agent],
  );

  // Stable handlers for the memoized children (ChatHeader / ChatRightRail) and
  // the sidebar — all are pure setState calls (deps []), so a composer or
  // right-panel click no longer allocates a fresh arrow per child each render.
  const openDetailsPanel = useCallback(() => setActiveRightPanelId('details'), []);
  const openMobileSidebar = useCallback(() => setMobileSidebarOpen(true), []);
  const toggleCanvasPanel = useCallback(
    () => setActiveRightPanelId((p) => (p === 'diagram' ? null : 'diagram')),
    [],
  );
  const openSnapshots = useCallback(() => setSnapshotsOpen(true), []);
  const handleViewChange = useCallback((v: 'active' | 'archived') => {
    setView(v);
    setSelectedId(null);
  }, []);
  const handleSelectSession = useCallback((id: number) => {
    setSelectedId(id);
    setMobileSidebarOpen(false);
  }, []);
  const closeMobileSidebar = useCallback(() => setMobileSidebarOpen(false), []);

  // Stabilize the two inline-computed <Composer> props. Without these, each
  // parent render would allocate a fresh array / React element and bust the
  // Composer memo even though nothing the composer cares about changed.
  const reasoningLevels = useMemo(
    () => resolveReasoningLevels(provider, providerOptions, model),
    [provider, providerOptions, model],
  );
  const queuedStrip = useMemo(
    () => <QueuedMessages items={queue.items} onPromote={queue.promote} onRemove={queue.remove} />,
    [queue.items, queue.promote, queue.remove],
  );

  return (
    // Tooltips use the single root <TooltipProvider> in App.tsx — a nested one
    // here was redundant (extra Radix context layer re-rendering on every chat
    // state change). Removed; the remaining rich Radix tooltips still work.
    <>
      <Dialog open={newSessionOpen} onOpenChange={setNewSessionOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('chat:newSessionTitle')}</DialogTitle>
            <DialogDescription>{t('chat:newSessionDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={t('chat:sessionTitlePlaceholder')}
            value={newSessionTitle}
            onChange={(e) => setNewSessionTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmNewSession();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewSessionOpen(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button onClick={confirmNewSession}>{t('common:actions.create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {isGlobal && (
        <GlobalNewSessionDialog
          open={globalNewOpen}
          onOpenChange={setGlobalNewOpen}
          onCreate={createGlobalSession}
        />
      )}
      {isGlobal && selectedId != null && (
        <ManageGlobalProjectsDialog
          open={manageProjectsOpen}
          onOpenChange={setManageProjectsOpen}
          sessionId={selectedId}
          linkedProjects={sessionData?.linked_projects ?? []}
          streaming={streaming}
          onChanged={() => { void refetchSession(); }}
        />
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
      {/* Snapshots is the only ex-modal that stays modal — full-width
          diff viewer needs the viewport. The other five (skills, tools,
          metrics, tool-stats, details) live in the right rail as panels. */}
      <div className="flex h-full min-h-0">
        {/* `agent-chat-cols-v2` bumps the persisted-storage key so the
            three-panel layout (sessions / chat / right-rail) gets a fresh
            split instead of inheriting the legacy two-panel sizing — which
            could leave the right panel taking ~50% of the viewport and
            squishing the chat header into a wrap. */}
        <PanelGroup direction="horizontal" autoSaveId="agent-chat-cols-v2" className="flex-1 min-h-0">
        <Panel
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
          sessions={sessions ?? null}
          groups={groups ?? null}
          view={view}
          onViewChange={handleViewChange}
          selectedId={selectedId}
          onSelect={handleSelectSession}
          mobileOpen={mobileSidebarOpen}
          onMobileClose={closeMobileSidebar}
          onNew={handleNewSession}
          onDelete={handleDelete}
          onRename={handleRenameSession}
          onDuplicate={handleDuplicate}
          onBatchDelete={handleBatchDelete}
          onDeleteAll={handleDeleteAll}
          onArchive={handleArchive}
          onFavorite={handleFavorite}
          onBatchArchive={handleBatchArchive}
          onMoveToGroup={handleMoveToGroup}
          onBatchMoveToGroup={handleBatchMoveToGroup}
          onCreateGroup={handleCreateGroup}
          onRenameGroup={handleRenameGroup}
          onDeleteGroup={handleDeleteGroup}
          projectName={isGlobal ? t('chat:global.workspaceName') : (projectName ?? '')}
          groupBy={isGlobal ? 'workspace' : 'group'}
        />
        </Panel>
        <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors hidden lg:block" />
        <Panel id="chat-main" order={2} minSize={40} className="min-w-0 relative">
          {/* Collapse/expand the sessions sidebar. */}
          <button
            onClick={() =>
              sidebarCollapsed
                ? sessionsPanelRef.current?.expand()
                : sessionsPanelRef.current?.collapse()
            }
            title={sidebarCollapsed ? 'Show sessions' : 'Hide sessions'}
            className="absolute top-1.5 left-1.5 z-20 h-6 w-6 flex items-center justify-center rounded-md bg-card/80 border text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            {sidebarCollapsed ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
          </button>
          {!selectedId ? (
            <main className="flex h-full w-full min-w-0 bg-card overflow-hidden min-h-0">
              <EmptyChatState
                onNew={handleNewSession}
                projectId={projectId}
                projectName={isGlobal ? t('chat:global.workspaceName') : (projectName ?? '')}
                onOpenSidebar={() => setMobileSidebarOpen(true)}
              />
            </main>
          ) : (
            <main className="flex h-full w-full min-w-0 bg-card overflow-hidden min-h-0 flex-col">
              {sessionData?.session && (
                <ChatHeader
                  session={sessionData.session}
                  streaming={streaming}
                  runDelta={runDelta}
                  lastUsage={lastUsage}
                  stats={stats}
                  contextStatus={contextStatus}
                  indexStatus={indexStatus}
                  // Details/Tools/Skills/Metrics/ToolStats live in the right
                  // rail now — the header only handles mobile sidebar toggle
                  // and the tokens widget. The activity rail (rendered next
                  // to the right panel) owns those buttons.
                  onOpenDetails={openDetailsPanel}
                  onSummarizeClear={handleSummarizeClear}
                  summarizing={summarizing}
                  onOpenSidebar={openMobileSidebar}
                  pendingSnapshots={snapshotPending}
                  // Builder-style canvas toggle — shown for diagram sessions so
                  // the live draw.io canvas is openable even where the 40px
                  // activity rail is hidden (split/narrow mounts).
                  showCanvasToggle={agent === 'diagram' || getDiagram(selectedId ?? 0) != null}
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
                <MessageList
                  sessionData={sessionData ?? null}
                  currentTurn={currentTurn}
                  streaming={streaming}
                  preflight={preflight}
                  doneReason={doneReason}
                  error={error}
                  liveTurnDuplicatedInHistory={liveTurnDuplicatedInHistory}
                  persistedToolUseIds={persistedToolUseIds}
                  fallbackProviderId={provider}
                  tasksState={tasksState}
                  handlers={handlers}
                  onLoadEarlier={loadEarlierMessages}
                />
              </div>
              <div className="relative">
              {indexing && <IndexingOverlay projectId={projectIndexId} />}
              <Composer
                ref={composerRef}
                filePicks={filePicks}
                onRemovePick={togglePick}
                onClearPicks={clearPicks}
                skillPicks={skillPicks}
                onRemoveSkillPick={toggleSkillPick}
                onClearSkillPicks={clearSkillPicks}
                agent={agent}
                setAgent={handleAgentChange}
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
                setMaxTurns={setMaxTurns}
                sessionId={selectedId}
                thinking={thinking}
                setThinking={setThinking}
                supportsThinking={providerSupportsThinking(provider, providerOptions, model)}
                describeImages={describeImages}
                setDescribeImages={setDescribeImages}
                fallbackProvider={fallbackProvider}
                fallbackModel={fallbackModel}
                onFallbackChange={handleFallbackChange}
                temperature={sessionTemperature}
                setTemperature={handleTemperatureChange}
                reasoningEffort={reasoningEffort}
                setReasoningEffort={handleReasoningEffortChange}
                reasoningLevels={reasoningLevels}
                planDepth={planDepth}
                setPlanDepth={handlePlanDepthChange}
                outputCapLevel={outputCapLevel}
                setOutputCapLevel={handleOutputCapLevelChange}
                toolPermissionMode={toolPermissionMode}
                setToolPermissionMode={handleToolPermissionModeChange}
                getModelsForProvider={getModelsForProvider}
                selectedPipelineId={selectedPipelineId}
                setSelectedPipelineId={setSelectedPipelineId}
                onRunPipeline={handleRunPipeline}
                queueable={!!selectedId && selectedPipelineId == null}
                onQueue={handleQueue}
                queuedStrip={queuedStrip}
              />
              </div>
            </main>
          )}
        </Panel>
        {selectedId && activeRightPanelId && (
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
                skillPicks={skillPicks}
                onToggleSkillPick={toggleSkillPick}
                pipelineRuntime={pipelineRuntime}
                pluginWindows={pluginPanelWindows}
                onClose={() => setActiveRightPanelId(null)}
              />
            </Panel>
          </>
        )}
        </PanelGroup>
        {/* Activity rail — fixed 40px, sits flush right when a session is
            open. Hidden on mobile (where the sidebar drawer already
            provides navigation, and 40px would crowd the chat). */}
        {selectedId && (
          <div className="hidden lg:block">
            <ChatRightRail
              activePanelId={activeRightPanelId}
              onSelectPanel={setActiveRightPanelId}
              onOpenSnapshots={openSnapshots}
              pendingSnapshots={snapshotPending}
              unreadNotifications={unreadNotifications}
              pluginWindows={pluginPanelWindows}
            />
          </div>
        )}
      </div>
      {selectedId != null && (
        <Dialog open={snapshotsOpen} onOpenChange={setSnapshotsOpen}>
          <DialogContent
            className="p-0 gap-0 max-w-[100vw] sm:max-w-[1400px] w-[100vw] sm:w-[95vw] h-[100dvh] sm:h-[90vh] sm:max-h-[90vh] rounded-none sm:rounded-xl overflow-hidden flex flex-col"
          >
            <DialogHeader className="px-4 py-2.5 border-b bg-card flex-shrink-0">
              <DialogTitle className="text-sm">Session Snapshots</DialogTitle>
              <DialogDescription className="sr-only">
                Review every file altered by the agent in this session. Accept or revert per hunk, per file, or all at once.
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 min-h-0">
              <SnapshotsPanel
                scope="coder"
                sessionId={selectedId}
                refreshKey={snapshotTick}
                onSubmitReviewMessage={handleSnapshotReviewMessage}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
