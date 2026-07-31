/**
 * Session engine for the editor Copilot rail. Deliberately re-composes the
 * SAME primitives AgentChat uses — `useAgentStream`, `useAgentChatState`,
 * `useApi` — so the session lifecycle (streaming, reattach, done refetch,
 * provider/model restore) is reused, not re-implemented. The rail is
 * "AgentChat minus the sessions-sidebar / right-rail / dialog chrome, plus
 * editor-context staging".
 *
 * Fork, pipelines and snapshots intentionally stay in the full Chat tab
 * (pipelines need the runtime/progress panel the rail doesn't host); fallback
 * and tool-permission-mode ARE exposed here (settings dialog / shield). The
 * rail is the lightweight inline assistant; sessions are shared with that tab
 * (same project_id).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiDelete, apiPatch, apiPost, useApi } from '../../../hooks/useApi.js';
import {
  useAgentCurrentTurn,
  useAgentStream,
  type AgentAttachment,
} from '../../../hooks/useAgentStream.js';
import { useMessageQueue, type QueueDeliver, type QueueMode } from '../../chat/composer/useMessageQueue.js';
import { useAgentChatState } from '../../chat/useAgentChatState.js';
import {
  buildPersistedLiveReconciliation,
  isLiveTurnDuplicatedInHistory,
  liveTurnReconciliationRevision,
} from '../../chat/utils.js';
import { providerSupportsThinking, resolveReasoningLevels } from '../../chat/composer/provider-caps.js';
import {
  executionModeChangeLocked,
  hydratedReasoningEffort,
  modelCanReason,
  ultraManagesThinking,
} from '../../chat/execution-mode-state.js';
import { useSessionAgent } from '../../chat/useSessionAgent.js';
import type { SessionLaunchConfig } from '../../chat/SessionLaunchDialog.js';
import { fetchSnapshotList } from '../../snapshots/api.js';
import type { SnapshotFileSummary } from '../../snapshots/types.js';
import { buildSnapshotFileMap, type SnapshotActions } from '../../chat/messages/snapshot-files-context.js';
import {
  allocateOptimisticMessageId,
  appendOptimisticUserMessage,
  mergeEarlierMessagePage,
  sessionDataForSelection,
} from '../../chat/messages/session-message-data.js';
import type { CoderSession, CoderSessionGroup, MessagePage, PromptHandlers, SessionData } from '../../chat/types.js';
import {
  editorChatContextActions,
  formatSelections,
  selectionId,
  useEditorChatContext,
  MAX_SELECTION_CHARS,
} from '../../../state/editor-chat-context.js';
import { readActiveSelection } from '../../workspace/editor/chat-actions.js';
import { useEditorSessionSettings } from './useEditorSessionSettings.js';
import type { NotificationSourceContext } from '../../notifications/index.js';
import type { AgentPreset } from '@mcp/api-bus';
import { DEFAULT_SESSION_MAX_AUTO_CONTINUES } from '@mcp/code-agent/sessions/run-limits.js';
import {
  consumePendingAttachments,
  consumeSelectionPrefix,
  onStudioSend,
  usePublishAgentBusy,
} from '../../builder/studio/studio-context-store.js';

type PendingAutoTitleSessions = Set<string> & {
  creationInFlight?: boolean;
};

interface EditorChatSessionOptions {
  initialSessionId?: string;
  initialAgent?: AgentId;
  agentLock?: AgentId;
  includeEditorContext?: boolean;
  selectionPrefixSessionId?: number;
  newSessionTitle?: string;
  initialProvider?: string;
  initialModel?: string;
  initialThinking?: boolean;
  initialReasoningEffort?: string | null;
}

type AgentId = AgentPreset;

export function useEditorChatSession(projectId: number, options: EditorChatSessionOptions = {}) {
  const {
    initialSessionId,
    initialAgent,
    agentLock,
    includeEditorContext = true,
    selectionPrefixSessionId,
    newSessionTitle = 'Nova sessão',
    initialProvider,
    initialModel,
    initialThinking,
    initialReasoningEffort,
  } = options;
  const { selections } = useEditorChatContext(projectId);

  const { data: sessions, refetch: refetchSessions, update: updateSessions } = useApi<CoderSession[]>(
    `/coder/sessions?project_id=${projectId}&archived=0`,
  );
  const { data: groups, refetch: refetchGroups } = useApi<CoderSessionGroup[]>(
    `/coder/groups?project_id=${projectId}`,
  );
  const [selectedId, setSelectedId] = useState<string | null>(() => initialSessionId ?? null);
  const [creating, setCreating] = useState(false);

  const [provider, setProvider] = useState(initialProvider ?? 'zai');
  const [model, setModel] = useState(initialModel ?? '');
  const [maxTurns, setMaxTurns] = useState<number | null>(null);
  const [maxAutoContinues, setMaxAutoContinues] = useState(
    DEFAULT_SESSION_MAX_AUTO_CONTINUES,
  );
  const [temperature, setTemperature] = useState<number | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(initialReasoningEffort ?? null);
  const [planDepth, setPlanDepth] = useState<string | null>(null);
  const [thinking, setThinking] = useState(initialThinking ?? false);
  // Keep the creation lock on this pre-existing ref. Adding a separate hook in
  // the middle of this shared hook corrupts Fast Refresh's preserved hook slots.
  const pendingAutoTitle = useRef<PendingAutoTitleSessions>(new Set());
  const [snapshotFiles, setSnapshotFiles] = useState<Map<string, SnapshotFileSummary>>(new Map());
  const [snapshotRefreshNonce, setSnapshotRefreshNonce] = useState(0);

  const sessionUrl = selectedId ? `/coder/sessions/${selectedId}?tail=120` : '';
  const { data: sessionData, refetch: refetchSession, update: updateSessionData } = useApi<SessionData>(sessionUrl);
  const selectedSessionData = useMemo(
    () => sessionDataForSelection(sessionData, selectedId),
    [selectedId, sessionData],
  );
  const {
    agent,
    setAgent: setSessionAgent,
    changeAgentAndWait,
    awaitPendingAgentChange,
    adoptAgent,
    getAgent,
  } = useSessionAgent({
    selectedId,
    sessionData: selectedSessionData,
    updateSessionData,
    updateSessions,
    refetchSession,
    initialAgent: agentLock ?? initialAgent ?? 'explore',
  });
  const handleAgentChange = useCallback((next: AgentId): void => {
    if (agentLock) {
      void changeAgentAndWait(agentLock);
      return;
    }
    setSessionAgent(next);
  }, [agentLock, changeAgentAndWait, setSessionAgent]);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const messagePageAbortControllersRef = useRef<Set<AbortController>>(new Set());
  useEffect(() => () => {
    for (const controller of messagePageAbortControllersRef.current) controller.abort();
    messagePageAbortControllersRef.current.clear();
  }, [selectedId]);

  const notificationContext = useMemo<NotificationSourceContext | undefined>(() => {
    if (!selectedId) return undefined;
    return {
      target: {
        kind: 'project',
        route: `/projects/${projectId}?session=${selectedId}`,
        scopeId: projectId,
        sessionId: selectedId,
        label: selectedSessionData?.session.title ?? `Project ${projectId} session`,
      },
    };
  }, [projectId, selectedId, selectedSessionData?.session.title]);

  const stream = useAgentStream(selectedId, notificationContext);
  const {
    streaming, doneReason, error, sendMessage, reattach, abort, clearCurrentTurn, tasksRefreshTick, snapshotTick,
    answerQuestion, respondToPlan, decideGate, respondToTasks, respondToToolApproval, switchProvider, pendingApprovals,
  } = stream;
  const currentTurn = useAgentCurrentTurn(selectedId);
  usePublishAgentBusy(selectionPrefixSessionId, streaming);

  const { providerOptions, currentProviderModels, getModelsForProvider, tasksState, persistedToolUseIds } =
    useAgentChatState({
      selectedId,
      doneReason,
      tasksRefreshTick,
      sessionData: selectedSessionData,
      provider,
      model,
      setProvider,
      setModel,
    });
  const liveReconciliation = useMemo(
    () => buildPersistedLiveReconciliation(
      selectedSessionData?.messages ?? [],
      selectedSessionData?.preceding_user_message_id,
      (selectedSessionData?.tool_results ?? []).map((result) => result.tool_use_id),
    ),
    [selectedSessionData],
  );
  const currentTurnRef = useRef(currentTurn);
  currentTurnRef.current = currentTurn;
  const liveReconciliationRevision = liveTurnReconciliationRevision(
    currentTurn,
    liveReconciliation.tailTextLength,
    liveReconciliation.tailThinkingLength,
  );
  const liveTurnDuplicatedInHistory = useMemo(
    () => isLiveTurnDuplicatedInHistory(
      currentTurnRef.current,
      liveReconciliation,
      persistedToolUseIds,
    ),
    [liveReconciliation, liveReconciliationRevision, persistedToolUseIds],
  );

  const settings = useEditorSessionSettings(selectedId, selectedSessionData, {
    updateSessionData,
    runnerBusy: executionModeChangeLocked(
      streaming,
      selectedSessionData?.session.status,
      selectedSessionData?.session.id,
      selectedId,
    ),
    refetchSession,
  });

  useEffect(() => {
    if (initialSessionId) setSelectedId(initialSessionId);
  }, [initialSessionId]);

  useEffect(() => {
    const onSessionsChanged = () => {
      refetchSessions();
      refetchGroups();
    };
    window.addEventListener('coder:sessions-changed', onSessionsChanged);
    return () => window.removeEventListener('coder:sessions-changed', onSessionsChanged);
  }, [refetchSessions, refetchGroups]);

  useEffect(() => {
    if (agentLock && selectedId == null) adoptAgent(agentLock, null);
  }, [agentLock, selectedId, adoptAgent]);

  // Guided surfaces can choose the starting agent without locking the
  // conversation. Apply only before a session is selected; once a session is
  // open, its persisted agent and any manual picker changes take precedence.
  useEffect(() => {
    if (agentLock || selectedId != null || !initialAgent) return;
    adoptAgent(initialAgent, null);
  }, [agentLock, initialAgent, selectedId, adoptAgent]);

  // Guided surfaces can configure the session before it exists (App Studio's
  // spec specialist launcher). Apply those defaults only while no session is
  // selected; once a session is open, the persisted session row is the source
  // of truth.
  useEffect(() => {
    if (selectedId != null) return;
    if (initialProvider) setProvider(initialProvider);
    if (initialModel !== undefined) setModel(initialModel);
    if (initialThinking !== undefined) setThinking(initialThinking);
    if (initialReasoningEffort !== undefined) setReasoningEffort(initialReasoningEffort ?? null);
  }, [selectedId, initialProvider, initialModel, initialThinking, initialReasoningEffort]);

  // Auto-reattach to an in-flight run (same probe AgentChat uses).
  useEffect(() => {
    if (!selectedId || streaming) return;
    let cancelled = false;
    fetch(`/api/coder/sessions/${selectedId}/status`)
      .then((r) => (r.ok ? r.json() : { active: false }))
      .then((s: { active: boolean }) => {
        if (!cancelled && s.active) void reattach(selectedId, () => refetchSession());
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Project switch: the editor Copilot rail shares the keep-alive code surface
  // and is re-rendered in place with a new projectId, so selectedId would keep
  // the PREVIOUS project's session open (its live stream, composer, and the
  // per-session agent/temperature/effort settings). Drop it when projectId
  // changes so the rail re-scopes to the incoming project's session list.
  const prevProjectIdRef = useRef(projectId);
  useEffect(() => {
    if (prevProjectIdRef.current === projectId) return;
    prevProjectIdRef.current = projectId;
    setSelectedId(null);
    clearCurrentTurn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // End-of-run: refetch the persisted session. The live turn stays visible
  // until liveTurnDuplicatedInHistory proves that the refetch contains it.
  useEffect(() => {
    if (!doneReason || !selectedId) return;
    let cancelled = false;
    (async () => {
      await Promise.resolve(refetchSession());
      await Promise.resolve(refetchSessions());
      if (!cancelled) {
        window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
      }
    })();
    return () => { cancelled = true; };
  }, [doneReason, selectedId, refetchSession, refetchSessions]);

  // Hydrate the persisted model-settings overrides from the session row so the
  // settings dialog opens reflecting the OPEN session instead of blank defaults
  // (the bug where temperature/effort/plan-depth always reset). Same read
  // pattern AgentChat uses — these values flow through the filesystem session
  // projection. A null turn limit is intentional and means unlimited.
  useEffect(() => {
    const s = selectedSessionData?.session;
    if (!s) return;
    const tmp = (s as { temperature_override?: number | null } | undefined)?.temperature_override;
    setTemperature(typeof tmp === 'number' ? tmp : null);
    const effort = hydratedReasoningEffort(s, selectedId);
    if (effort !== undefined) setReasoningEffort(effort);
    const dep = s?.plan_depth_override;
    setPlanDepth(typeof dep === 'string' && dep.length > 0 ? dep : null);
    setThinking(s.thinking_enabled === true);
    setMaxTurns(
      typeof s.max_turns === 'number' && s.max_turns > 0
        ? s.max_turns
        : null,
    );
    setMaxAutoContinues(
      typeof s.max_auto_continues === 'number' && s.max_auto_continues >= 0
        ? s.max_auto_continues
        : DEFAULT_SESSION_MAX_AUTO_CONTINUES,
    );
  }, [selectedId, selectedSessionData?.session]);

  const ensureAgentLock = useCallback(async () => {
    if (!agentLock || !selectedId) return;
    if (selectedSessionData?.session.agent === agentLock) return;
    await changeAgentAndWait(agentLock);
  }, [agentLock, selectedId, selectedSessionData?.session.agent, changeAgentAndWait]);

  useEffect(() => {
    if (!agentLock || !selectedId) return;
    if (selectedSessionData?.session.agent === agentLock) return;
    void ensureAgentLock();
  }, [agentLock, selectedId, selectedSessionData?.session.agent, ensureAgentLock]);

  // Avoid double-rendering the live turn once it lands in the DB.
  useEffect(() => {
    if (liveTurnDuplicatedInHistory) clearCurrentTurn();
  }, [clearCurrentTurn, liveTurnDuplicatedInHistory]);

  const refreshSnapshots = useCallback(() => setSnapshotRefreshNonce((n) => n + 1), []);
  const snapshotActions = useMemo<SnapshotActions | null>(
    () => selectedId
      ? {
          scope: 'coder',
          sessionId: selectedId,
          openSnapshots: () => undefined,
          refresh: refreshSnapshots,
          showToolbar: false,
        }
      : null,
    [selectedId, refreshSnapshots],
  );

  useEffect(() => {
    if (!selectedId) {
      setSnapshotFiles(new Map());
      return;
    }
    let cancelled = false;
    fetchSnapshotList('coder', selectedId, { includeClosed: true })
      .then((r) => {
        if (!cancelled) setSnapshotFiles(buildSnapshotFileMap(r.files));
      })
      .catch(() => {
        if (!cancelled) setSnapshotFiles(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, snapshotTick, snapshotRefreshNonce, doneReason]);

  const createSession = useCallback(async (
    config: Partial<SessionLaunchConfig> & { useLastModel?: boolean } = {},
  ): Promise<string | null> => {
    if (pendingAutoTitle.current.creationInFlight) return null;
    pendingAutoTitle.current.creationInFlight = true;
    setCreating(true);
    try {
      const selectedProvider = config.provider || provider;
      const firstModel = getModelsForProvider(selectedProvider)[0];
      const fallbackModel = firstModel
        ? firstModel.mode ? `${firstModel.id}::${firstModel.mode}` : firstModel.id
        : '';
      const selectedModel = config.model || model || fallbackModel;
      const selectedAgent = agentLock ?? config.agent ?? agent;
      const selectedReasoningEffort = config.useLastModel
        ? null
        : (config.reasoningEffort === undefined ? reasoningEffort : config.reasoningEffort);
      const selectedExecutionMode = config.useLastModel
        ? 'standard'
        : (config.executionMode === undefined ? settings.executionMode : config.executionMode);
      const selectedThinking = config.useLastModel ? false : (config.thinking ?? thinking);
      const selectedMaxTurns = config.maxTurns ?? null;
      const selectedMaxAutoContinues =
        config.maxAutoContinues ?? DEFAULT_SESSION_MAX_AUTO_CONTINUES;
      const selectedTemperature = config.useLastModel
        ? null
        : (config.temperature === undefined ? temperature : config.temperature);
      const explicitTitle = config.title?.trim();

      const created = await apiPost<CoderSession>('/coder/sessions', {
        project_id: projectId,
        title: (explicitTitle || newSessionTitle).slice(0, 80),
        provider: selectedProvider,
        model: selectedModel,
        use_last_model: config.useLastModel === true,
        agent: selectedAgent,
        execution_mode: selectedExecutionMode,
        reasoning_effort: selectedReasoningEffort || null,
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
      settings.adoptExecutionMode(selectedExecutionMode);
      setThinking(selectedThinking);
      setMaxTurns(selectedMaxTurns);
      setMaxAutoContinues(selectedMaxAutoContinues);
      setTemperature(selectedTemperature);
      if (!explicitTitle) pendingAutoTitle.current.add(created.id);
      updateSessions((prev) => [created, ...prev.filter((session) => session.id !== created.id)]);
      refetchSessions();
      setSelectedId(created.id);
      window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
      return created.id;
    } finally {
      pendingAutoTitle.current.creationInFlight = false;
      setCreating(false);
    }
  }, [projectId, newSessionTitle, provider, model, getModelsForProvider, agentLock, agent, reasoningEffort, settings.executionMode, settings.adoptExecutionMode, adoptAgent, thinking, temperature, updateSessions, refetchSessions]);

  const archiveSession = useCallback(async (id: string, archived = true) => {
    await apiPatch(`/coder/sessions/${id}/archive`, { archived });
    if (selectedId === id) setSelectedId(null);
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [selectedId, refetchSessions]);

  const deleteSession = useCallback(async (id: string) => {
    await apiDelete(`/coder/sessions/${id}`);
    if (selectedId === id) setSelectedId(null);
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [selectedId, refetchSessions]);

  const favoriteSession = useCallback(async (id: string, favorite: boolean) => {
    await apiPatch(`/coder/sessions/${id}/favorite`, { favorite });
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [refetchSessions]);

  const renameSession = useCallback(async (id: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    await apiPatch(`/coder/sessions/${id}/title`, { title: trimmed });
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [refetchSessions]);

  const duplicateSession = useCallback(async (id: string) => {
    const res = await apiPost<{ session: CoderSession }>(`/coder/sessions/${id}/duplicate`, {});
    refetchSessions();
    setSelectedId(res.session.id);
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
    return res.session.id;
  }, [refetchSessions]);

  const moveSessionToGroup = useCallback(async (id: string, groupId: number | null) => {
    await apiPatch(`/coder/sessions/${id}/group`, { group_id: groupId });
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [refetchSessions]);

  const createGroup = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await apiPost<CoderSessionGroup>('/coder/groups', {
      project_id: projectId,
      name: trimmed,
    });
    refetchGroups();
    refetchSessions();
  }, [projectId, refetchGroups, refetchSessions]);

  const handleSend = useCallback(async (text: string, atts: AgentAttachment[], selectedSkillIds?: string[]) => {
    if (!text.trim() || !selectedId) return;
    const shouldAutoTitle = pendingAutoTitle.current.has(selectedId);
    if (shouldAutoTitle) pendingAutoTitle.current.delete(selectedId);
    // Prepend staged code selections as <selected-code> blocks — pinned
    // (Ctrl/Cmd+I) plus the current live editor selection (deduped) — then
    // clear ALL staged context (file refs are already inlined by the
    // Composer as <file_refs>; clear() also drops the live selection).
    let editorPrefix = '';
    if (includeEditorContext) {
      const st = editorChatContextActions();
      // Read the live selection FRESH from the editor (no debounce) so a snippet
      // highlighted right before Send still rides along; dedupe against pinned.
      const raw = readActiveSelection();
      const live = raw && raw.projectId === projectId
        ? {
            id: selectionId(raw.path, raw.startLine, raw.endLine),
            path: raw.path,
            startLine: raw.startLine,
            endLine: raw.endLine,
            text: raw.text.slice(0, MAX_SELECTION_CHARS),
          }
        : null;
      const allSels = live && !selections.some((x) => x.id === live.id) ? [...selections, live] : selections;
      editorPrefix = formatSelections(allSels);
      st.clear(projectId);
    }
    const studioPrefix = selectionPrefixSessionId ? consumeSelectionPrefix(selectionPrefixSessionId) : '';
    const shots = selectionPrefixSessionId ? consumePendingAttachments(selectionPrefixSessionId) : [];
    const prefix = [editorPrefix, studioPrefix].filter(Boolean).join('\n');
    const outgoing = prefix ? `${prefix}\n\n${text}` : text;
    const allAtts = shots.length ? [...atts, ...shots] : atts;
    const optimisticMessageId = allocateOptimisticMessageId();
    updateSessionData((previous) => appendOptimisticUserMessage(previous, {
      sessionId: selectedId,
      messageId: optimisticMessageId,
      text: outgoing,
      attachments: allAtts,
      selectedSkillIds,
    }));
    await settings.awaitPendingExecutionMode();
    await ensureAgentLock();
    await awaitPendingAgentChange();
    await sendMessage(outgoing, async () => {
      refetchSession();
      if (shouldAutoTitle) {
        apiPost<{ title: string }>(`/coder/sessions/${selectedId}/generate-title`, { content: text })
          .then(() => { refetchSessions(); window.dispatchEvent(new CustomEvent('coder:sessions-changed')); })
          .catch((err) => console.warn('[editor-chat] generate-title failed:', err));
      }
    }, { attachments: allAtts, agent: getAgent(), maxTurns, maxAutoContinues, thinking, describeImages: settings.describeImages, selectedSkillIds });
  }, [selectedId, settings.awaitPendingExecutionMode, includeEditorContext, selectionPrefixSessionId, selections, projectId, updateSessionData, sendMessage, refetchSession, refetchSessions, ensureAgentLock, awaitPendingAgentChange, getAgent, maxTurns, maxAutoContinues, thinking, settings.describeImages]);

  // ─── Message queue (compose/enqueue while streaming) ───────────────
  // Live run → POST /inject (no new stream; the open SSE renders the injected
  // turn). No run → fall back to sendMessage (fresh streamed run). See the
  // AgentChat copy for the full rationale (avoids the mid-run stream-abort freeze).
  const deliverQueued = useCallback<QueueDeliver>(async (
    text,
    { interject, attachments, skillIds },
  ) => {
    if (!selectedId) return;
    try {
      const r = await apiPost<{ injected?: boolean; noActiveRun?: boolean }>(
        `/coder/sessions/${selectedId}/inject`,
        {
          content: text,
          interject,
          attachments,
          describe_images: settings.describeImages,
          selected_skill_ids: skillIds,
        },
      );
      if (r?.injected) { refetchSession(); return; }
    } catch { /* fall through to a fresh streamed send */ }
    await settings.awaitPendingExecutionMode();
    await ensureAgentLock();
    await awaitPendingAgentChange();
    await sendMessage(text, async () => { refetchSession(); }, {
      attachments,
      agent: getAgent(),
      maxTurns,
      maxAutoContinues,
      thinking,
      describeImages: settings.describeImages,
      selectedSkillIds: skillIds,
      interject,
    });
  }, [selectedId, settings.awaitPendingExecutionMode, sendMessage, refetchSession, ensureAgentLock, awaitPendingAgentChange, getAgent, maxTurns, maxAutoContinues, thinking, settings.describeImages]);
  const queue = useMessageQueue({ streaming, deliver: deliverQueued });
  const handleQueue = useCallback((
    text: string,
    mode: QueueMode,
    attachments: AgentAttachment[],
    skillIds?: string[],
  ) => {
    if (!selectedId) return;
    // Mirror handleSend's staged-context prefixing (selected-code), then clear.
    let editorPrefix = '';
    if (includeEditorContext) {
      const st = editorChatContextActions();
      const raw = readActiveSelection();
      const live = raw && raw.projectId === projectId
        ? { id: selectionId(raw.path, raw.startLine, raw.endLine), path: raw.path, startLine: raw.startLine, endLine: raw.endLine, text: raw.text.slice(0, MAX_SELECTION_CHARS) }
        : null;
      const allSels = live && !selections.some((x) => x.id === live.id) ? [...selections, live] : selections;
      editorPrefix = formatSelections(allSels);
      st.clear(projectId);
    }
    const studioPrefix = selectionPrefixSessionId ? consumeSelectionPrefix(selectionPrefixSessionId) : '';
    const shots = selectionPrefixSessionId
      ? consumePendingAttachments(selectionPrefixSessionId)
      : [];
    const prefix = [editorPrefix, studioPrefix].filter(Boolean).join('\n');
    queue.enqueue(
      prefix ? `${prefix}\n\n${text}` : text,
      mode,
      shots.length > 0 ? [...attachments, ...shots] : attachments,
      skillIds,
    );
  }, [selectedId, includeEditorContext, selectionPrefixSessionId, selections, projectId, queue]);
  useEffect(() => { queue.clear(); }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectionPrefixSessionId == null) return undefined;
    return onStudioSend(selectionPrefixSessionId, (text) => { void handleSend(text, []); });
  }, [selectionPrefixSessionId, handleSend]);

  const onSwitchProvider = useCallback(async (newProvider: string, newModel: string) => {
    setProvider(newProvider);
    setModel(newModel);
    if (selectedId && (streaming || selectedSessionData)) {
      await switchProvider(newProvider, newModel || undefined);
      refetchSession();
    }
  }, [selectedId, streaming, selectedSessionData, switchProvider, refetchSession]);

  const handleTemperatureChange = useCallback(async (next: number | null) => {
    setTemperature(next);
    if (!selectedId) return;
    try { await apiPatch(`/coder/sessions/${selectedId}/temperature`, { temperature: next }); } catch { /* optimistic */ }
  }, [selectedId]);

  const handleMaxTurnsChange = useCallback(async (next: number | null) => {
    setMaxTurns(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/run-limits`, {
        max_turns: next,
        max_auto_continues: maxAutoContinues,
      });
    } catch { /* optimistic */ }
  }, [maxAutoContinues, selectedId]);

  const handleMaxAutoContinuesChange = useCallback(async (next: number) => {
    setMaxAutoContinues(next);
    if (!selectedId) return;
    try {
      await apiPatch(`/coder/sessions/${selectedId}/run-limits`, {
        max_turns: maxTurns,
        max_auto_continues: next,
      });
    } catch { /* optimistic */ }
  }, [maxTurns, selectedId]);

  const handleReasoningEffortChange = useCallback(async (next: string | null) => {
    setReasoningEffort(next);
    if (!selectedId) return;
    try { await apiPatch(`/coder/sessions/${selectedId}/reasoning-effort`, { effort: next }); } catch { /* optimistic */ }
  }, [selectedId]);

  const handleThinkingChange = useCallback(async (next: boolean) => {
    setThinking(next);
    if (!selectedId) return;
    try { await apiPatch(`/coder/sessions/${selectedId}/thinking`, { thinking: next }); } catch { /* optimistic */ }
  }, [selectedId]);

  const handlePlanDepthChange = useCallback(async (next: string | null) => {
    setPlanDepth(next);
    if (!selectedId) return;
    try { await apiPatch(`/coder/sessions/${selectedId}/plan-depth`, { depth: next }); } catch { /* optimistic */ }
  }, [selectedId]);

  const loadEarlierMessages = useCallback(async (beforeId: number, limit = 40, includeArchived = false): Promise<number> => {
    const requestedSessionId = selectedId;
    if (!requestedSessionId) return 0;
    const controller = new AbortController();
    messagePageAbortControllersRef.current.add(controller);
    try {
      const archivedQs = includeArchived ? '&include_archived=1' : '';
      const res = await fetch(`/api/coder/sessions/${requestedSessionId}/messages?before_id=${beforeId}&limit=${limit}${archivedQs}`, {
        signal: controller.signal,
      });
      if (!res.ok) return 0;
      const page = (await res.json()) as MessagePage;
      if (!page.message_rows.length) return 0;
      if (selectedIdRef.current !== requestedSessionId) return 0;
      const preview = selectedSessionData
        ? mergeEarlierMessagePage(selectedSessionData, page, requestedSessionId)
        : null;
      if (!preview || preview.addedRows === 0) return 0;
      updateSessionData((prev) => mergeEarlierMessagePage(prev, page, requestedSessionId).data);
      return preview.addedRows;
    } catch {
      return 0;
    } finally {
      messagePageAbortControllersRef.current.delete(controller);
    }
  }, [selectedId, selectedSessionData, updateSessionData]);

  const handlers: PromptHandlers = useMemo(() => ({
    onAnswer: (answer) => answerQuestion(answer),
    onPlanResponse: (verdict) => respondToPlan(verdict),
    onTasksResponse: (verdict) => respondToTasks(verdict),
    onDecide: (answers) => decideGate(answers),
    onToolApproval: (toolUseId, verdict) => respondToToolApproval(toolUseId, verdict),
  }), [answerQuestion, respondToPlan, decideGate, respondToTasks, respondToToolApproval]);

  return {
    sessions: sessions ?? null, groups: groups ?? null, refetchSessions, selectedId, setSelectedId,
    createSession, creating, archiveSession, deleteSession, favoriteSession, renameSession, duplicateSession,
    moveSessionToGroup, createGroup,
    sessionData: selectedSessionData, streaming, currentTurn, doneReason, error, pendingApprovals, respondToToolApproval,
    liveReconciliation, liveTurnDuplicatedInHistory, persistedToolUseIds, tasksState, handlers, loadEarlierMessages, abort, handleSend,
    snapshotActions, snapshotFiles,
    queue, handleQueue,
    provider, model, setModel, agent, setAgent: handleAgentChange,
    maxTurns, setMaxTurns: handleMaxTurnsChange,
    maxAutoContinues,
    setMaxAutoContinues: handleMaxAutoContinuesChange,
    temperature, setTemperature: handleTemperatureChange, onSwitchProvider,
    reasoningEffort, setReasoningEffort: handleReasoningEffortChange,
    planDepth, setPlanDepth: handlePlanDepthChange,
    reasoningLevels: resolveReasoningLevels(provider, providerOptions, model),
    providerOptions, currentProviderModels, getModelsForProvider,
    thinking, setThinking: handleThinkingChange, supportsThinking: providerSupportsThinking(provider, providerOptions, model),
    ultraControlsThinking: ultraManagesThinking(settings.executionMode, modelCanReason(provider, providerOptions, model)),
    ...settings,
  };
}
