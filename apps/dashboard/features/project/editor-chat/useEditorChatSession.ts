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
import { useAgentStream, type AgentAttachment } from '../../../hooks/useAgentStream.js';
import { useMessageQueue, type QueueDeliver, type QueueMode } from '../../chat/composer/useMessageQueue.js';
import { useAgentChatState } from '../../chat/useAgentChatState.js';
import { providerSupportsThinking, resolveReasoningLevels } from '../../chat/composer/provider-caps.js';
import { PROVIDERS } from '../../chat/constants.js';
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
import {
  consumePendingAttachments,
  consumeSelectionPrefix,
  onStudioSend,
  usePublishAgentBusy,
} from '../../builder/studio/studio-context-store.js';

type AgentId = 'explore' | 'plan' | 'build' | 'admin' | 'spec' | 'api' | 'diagram' | 'builder';

interface EditorChatSessionOptions {
  initialSessionId?: number;
  agentLock?: AgentId;
  includeEditorContext?: boolean;
  selectionPrefixSessionId?: number;
  newSessionTitle?: string;
}

const VALID_AGENT_IDS = new Set<AgentId>(['explore', 'plan', 'build', 'admin', 'spec', 'api', 'diagram', 'builder']);

export function useEditorChatSession(projectId: number, options: EditorChatSessionOptions = {}) {
  const {
    initialSessionId,
    agentLock,
    includeEditorContext = true,
    selectionPrefixSessionId,
    newSessionTitle = 'Nova sessão',
  } = options;
  const { selections } = useEditorChatContext(projectId);

  const { data: sessions, refetch: refetchSessions } = useApi<CoderSession[]>(
    `/coder/sessions?project_id=${projectId}&archived=0`,
  );
  const { data: groups, refetch: refetchGroups } = useApi<CoderSessionGroup[]>(
    `/coder/groups?project_id=${projectId}`,
  );
  const [selectedId, setSelectedId] = useState<number | null>(() => initialSessionId ?? null);
  const [creating, setCreating] = useState(false);

  const [provider, setProvider] = useState('zai');
  const [model, setModel] = useState('');
  const [agent, setAgent] = useState<AgentId>(() => agentLock ?? 'explore');
  const [maxTurns, setMaxTurns] = useState<number | null>(null);
  const [temperature, setTemperature] = useState<number | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [planDepth, setPlanDepth] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const pendingAutoTitle = useRef<Set<number>>(new Set());

  const sessionUrl = selectedId ? `/coder/sessions/${selectedId}?tail=120` : '';
  const { data: sessionData, refetch: refetchSession, update: updateSessionData } = useApi<SessionData>(sessionUrl);

  const notificationContext = useMemo<NotificationSourceContext | undefined>(() => {
    if (!selectedId) return undefined;
    return {
      target: {
        kind: 'project',
        route: `/projects/${projectId}?session=${selectedId}`,
        scopeId: projectId,
        sessionId: selectedId,
        label: sessionData?.session.title ?? `Project ${projectId} session`,
      },
    };
  }, [projectId, selectedId, sessionData?.session.title]);

  const stream = useAgentStream(selectedId, notificationContext);
  const {
    streaming, currentTurn, doneReason, error, sendMessage, reattach, abort, clearCurrentTurn, tasksRefreshTick,
    answerQuestion, respondToPlan, decideGate, respondToTasks, respondToToolApproval, switchProvider,
  } = stream;
  usePublishAgentBusy(selectionPrefixSessionId, streaming);

  const { providerOptions, currentProviderModels, getModelsForProvider, tasksState, liveTurnDuplicatedInHistory, persistedToolUseIds } =
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

  const settings = useEditorSessionSettings(selectedId, sessionData ?? null);

  useEffect(() => {
    if (initialSessionId) setSelectedId(initialSessionId);
  }, [initialSessionId]);

  useEffect(() => {
    if (agentLock) setAgent(agentLock);
  }, [agentLock]);

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

  // Agent/mode hydration — reflect the session's real mode on (re)open and on
  // session switch. Keyed on session id so an end-of-run refetch doesn't
  // clobber a manual mid-session pick. Guided rails can lock the agent.
  useEffect(() => {
    if (agentLock) {
      setAgent(agentLock);
      return;
    }
    const a = (sessionData?.session as { agent?: string | null } | undefined)?.agent;
    if (a && VALID_AGENT_IDS.has(a as AgentId)) {
      setAgent(a as AgentId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionData?.session?.id, agentLock]);

  // Hydrate the persisted model-settings overrides from the session row so the
  // settings dialog opens reflecting the OPEN session instead of blank defaults
  // (the bug where temperature/effort/plan-depth always reset). Same read
  // pattern AgentChat uses — these columns flow through the full session
  // payload (migrations 150/151 + temperature_override). `null`/empty → the
  // model default. maxTurns is intentionally NOT hydrated: it has no persisted
  // column, it's a per-send param, so the "50" placeholder is correct.
  useEffect(() => {
    const s = sessionData?.session;
    const tmp = (s as { temperature_override?: number | null } | undefined)?.temperature_override;
    setTemperature(typeof tmp === 'number' ? tmp : null);
    const eff = s?.reasoning_effort_override;
    setReasoningEffort(typeof eff === 'string' && eff.length > 0 ? eff : null);
    const dep = s?.plan_depth_override;
    setPlanDepth(typeof dep === 'string' && dep.length > 0 ? dep : null);
  }, [sessionData?.session]);

  // Persist a manual dropdown pick immediately (applies to the next run).
  const handleAgentChange = useCallback((next: AgentId) => {
    if (agentLock) {
      setAgent(agentLock);
      if (selectedId) apiPatch(`/coder/sessions/${selectedId}/agent`, { agent: agentLock }).catch(() => {});
      return;
    }
    setAgent(next);
    if (selectedId) apiPatch(`/coder/sessions/${selectedId}/agent`, { agent: next }).catch(() => {});
  }, [agentLock, selectedId]);

  // Avoid double-rendering the live turn once it lands in the DB.
  useEffect(() => {
    if (liveTurnDuplicatedInHistory) clearCurrentTurn();
  }, [clearCurrentTurn, liveTurnDuplicatedInHistory]);

  const createSession = useCallback(async (): Promise<number | null> => {
    setCreating(true);
    try {
      const created = await apiPost<CoderSession>('/coder/sessions', {
        project_id: projectId,
        title: newSessionTitle,
        provider,
        model: model || PROVIDERS.find((p) => p.id === provider)?.defaultModel,
        agent: agentLock ?? undefined,
      });
      pendingAutoTitle.current.add(created.id);
      refetchSessions();
      setSelectedId(created.id);
      window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
      return created.id;
    } finally {
      setCreating(false);
    }
  }, [projectId, newSessionTitle, provider, model, agentLock, refetchSessions]);

  const archiveSession = useCallback(async (id: number, archived = true) => {
    await apiPatch(`/coder/sessions/${id}/archive`, { archived });
    if (selectedId === id) setSelectedId(null);
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [selectedId, refetchSessions]);

  const deleteSession = useCallback(async (id: number) => {
    await apiDelete(`/coder/sessions/${id}`);
    if (selectedId === id) setSelectedId(null);
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [selectedId, refetchSessions]);

  const favoriteSession = useCallback(async (id: number, favorite: boolean) => {
    await apiPatch(`/coder/sessions/${id}/favorite`, { favorite });
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [refetchSessions]);

  const renameSession = useCallback(async (id: number, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    await apiPatch(`/coder/sessions/${id}/title`, { title: trimmed });
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [refetchSessions]);

  const duplicateSession = useCallback(async (id: number) => {
    const res = await apiPost<{ session: CoderSession }>(`/coder/sessions/${id}/duplicate`, {});
    refetchSessions();
    setSelectedId(res.session.id);
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
    return res.session.id;
  }, [refetchSessions]);

  const moveSessionToGroup = useCallback(async (id: number, groupId: number | null) => {
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
    await sendMessage(outgoing, async () => {
      refetchSession();
      if (shouldAutoTitle) {
        apiPost<{ title: string }>(`/coder/sessions/${selectedId}/generate-title`, { content: text })
          .then(() => { refetchSessions(); window.dispatchEvent(new CustomEvent('coder:sessions-changed')); })
          .catch((err) => console.warn('[editor-chat] generate-title failed:', err));
      }
    }, { attachments: allAtts, agent: agentLock ?? agent, maxTurns, thinking, describeImages: settings.describeImages, selectedSkillIds });
  }, [selectedId, includeEditorContext, selectionPrefixSessionId, selections, projectId, sendMessage, refetchSession, refetchSessions, agentLock, agent, maxTurns, thinking, settings.describeImages]);

  // ─── Message queue (compose/enqueue while streaming) ───────────────
  // Live run → POST /inject (no new stream; the open SSE renders the injected
  // turn). No run → fall back to sendMessage (fresh streamed run). See the
  // AgentChat copy for the full rationale (avoids the mid-run stream-abort freeze).
  const deliverQueued = useCallback<QueueDeliver>(async (text, { interject, skillIds }) => {
    if (!selectedId) return;
    try {
      const r = await apiPost<{ injected?: boolean; noActiveRun?: boolean }>(
        `/coder/sessions/${selectedId}/inject`,
        { content: text, interject, selected_skill_ids: skillIds },
      );
      if (r?.injected) { refetchSession(); return; }
    } catch { /* fall through to a fresh streamed send */ }
    await sendMessage(text, async () => { refetchSession(); }, {
      agent: agentLock ?? agent, maxTurns, thinking, describeImages: settings.describeImages, selectedSkillIds: skillIds, interject,
    });
  }, [selectedId, sendMessage, refetchSession, agentLock, agent, maxTurns, thinking, settings.describeImages]);
  const queue = useMessageQueue({ streaming, deliver: deliverQueued });
  const handleQueue = useCallback((text: string, mode: QueueMode, skillIds?: string[]) => {
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
    if (selectionPrefixSessionId) consumePendingAttachments(selectionPrefixSessionId);
    const prefix = [editorPrefix, studioPrefix].filter(Boolean).join('\n');
    queue.enqueue(prefix ? `${prefix}\n\n${text}` : text, mode, skillIds);
  }, [selectedId, includeEditorContext, selectionPrefixSessionId, selections, projectId, queue]);
  useEffect(() => { queue.clear(); }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectionPrefixSessionId == null) return undefined;
    return onStudioSend(selectionPrefixSessionId, (text) => { void handleSend(text, []); });
  }, [selectionPrefixSessionId, handleSend]);

  const onSwitchProvider = useCallback(async (newProvider: string, newModel: string) => {
    setProvider(newProvider);
    setModel(newModel);
    if (selectedId && (streaming || sessionData)) {
      await switchProvider(newProvider, newModel || undefined);
      refetchSession();
    }
  }, [selectedId, streaming, sessionData, switchProvider, refetchSession]);

  const handleTemperatureChange = useCallback(async (next: number | null) => {
    setTemperature(next);
    if (!selectedId) return;
    try { await apiPatch(`/coder/sessions/${selectedId}/temperature`, { temperature: next }); } catch { /* optimistic */ }
  }, [selectedId]);

  const handleReasoningEffortChange = useCallback(async (next: string | null) => {
    setReasoningEffort(next);
    if (!selectedId) return;
    try { await apiPatch(`/coder/sessions/${selectedId}/reasoning-effort`, { effort: next }); } catch { /* optimistic */ }
  }, [selectedId]);

  const handlePlanDepthChange = useCallback(async (next: string | null) => {
    setPlanDepth(next);
    if (!selectedId) return;
    try { await apiPatch(`/coder/sessions/${selectedId}/plan-depth`, { depth: next }); } catch { /* optimistic */ }
  }, [selectedId]);

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
    } catch { return 0; }
  }, [selectedId, updateSessionData]);

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
    sessionData: sessionData ?? null, streaming, currentTurn, doneReason, error,
    liveTurnDuplicatedInHistory, persistedToolUseIds, tasksState, handlers, loadEarlierMessages, abort, handleSend,
    queue, handleQueue,
    provider, model, setModel, agent, setAgent: handleAgentChange, maxTurns, setMaxTurns,
    temperature, setTemperature: handleTemperatureChange, onSwitchProvider,
    reasoningEffort, setReasoningEffort: handleReasoningEffortChange,
    planDepth, setPlanDepth: handlePlanDepthChange,
    reasoningLevels: resolveReasoningLevels(provider, providerOptions, model),
    providerOptions, currentProviderModels, getModelsForProvider,
    thinking, setThinking, supportsThinking: providerSupportsThinking(provider, providerOptions, model),
    ...settings,
  };
}
