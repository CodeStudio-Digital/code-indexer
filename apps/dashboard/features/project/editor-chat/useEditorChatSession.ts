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
import { apiPatch, apiPost, useApi } from '../../../hooks/useApi.js';
import { useAgentStream, type AgentAttachment } from '../../../hooks/useAgentStream.js';
import { useAgentChatState } from '../../chat/useAgentChatState.js';
import { providerSupportsThinking } from '../../chat/composer/provider-caps.js';
import { PROVIDERS } from '../../chat/constants.js';
import type { CoderSession, MessagePage, PromptHandlers, SessionData } from '../../chat/types.js';
import {
  editorChatContextActions,
  formatSelections,
  selectionId,
  useEditorChatContext,
  MAX_SELECTION_CHARS,
} from '../../../state/editor-chat-context.js';
import { readActiveSelection } from '../../workspace/editor/chat-actions.js';
import { useEditorSessionSettings } from './useEditorSessionSettings.js';

type AgentId = 'explore' | 'plan' | 'build' | 'admin' | 'spec';

export function useEditorChatSession(projectId: number) {
  const { selections } = useEditorChatContext(projectId);

  const { data: sessions, refetch: refetchSessions } = useApi<CoderSession[]>(
    `/coder/sessions?project_id=${projectId}&archived=0`,
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const [provider, setProvider] = useState('zai');
  const [model, setModel] = useState('');
  const [agent, setAgent] = useState<AgentId>('explore');
  const [maxTurns, setMaxTurns] = useState<number | null>(null);
  const [temperature, setTemperature] = useState<number | null>(null);
  const [thinking, setThinking] = useState(false);
  const pendingAutoTitle = useRef<Set<number>>(new Set());

  const sessionUrl = selectedId ? `/coder/sessions/${selectedId}?tail=120` : '';
  const { data: sessionData, refetch: refetchSession, update: updateSessionData } = useApi<SessionData>(sessionUrl);

  const stream = useAgentStream(selectedId);
  const {
    streaming, currentTurn, doneReason, error, sendMessage, reattach, abort, clearCurrentTurn,
    answerQuestion, respondToPlan, respondToTasks, respondToToolApproval, switchProvider,
  } = stream;

  const { providerOptions, currentProviderModels, getModelsForProvider, tasksState, liveTurnDuplicatedInHistory } =
    useAgentChatState({ selectedId, doneReason, sessionData: sessionData ?? null, currentTurn, provider, model, setProvider, setModel });

  const settings = useEditorSessionSettings(selectedId, sessionData ?? null);

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

  // End-of-run: refetch the persisted session, then drop the live turn.
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
    return () => { cancelled = true; };
  }, [doneReason, selectedId, refetchSession, refetchSessions, clearCurrentTurn]);

  // Avoid double-rendering the live turn once it lands in the DB.
  const persistedMessageCount = sessionData?.messages.length ?? 0;
  useEffect(() => {
    if ((!streaming && currentTurn && persistedMessageCount > 0) || liveTurnDuplicatedInHistory) clearCurrentTurn();
  }, [persistedMessageCount, streaming, currentTurn, clearCurrentTurn, liveTurnDuplicatedInHistory]);

  const createSession = useCallback(async (): Promise<number | null> => {
    setCreating(true);
    try {
      const created = await apiPost<CoderSession>('/coder/sessions', {
        project_id: projectId,
        title: 'Nova sessão',
        provider,
        model: model || PROVIDERS.find((p) => p.id === provider)?.defaultModel,
      });
      pendingAutoTitle.current.add(created.id);
      refetchSessions();
      setSelectedId(created.id);
      window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
      return created.id;
    } finally {
      setCreating(false);
    }
  }, [projectId, provider, model, refetchSessions]);

  const handleSend = useCallback(async (text: string, atts: AgentAttachment[], selectedSkillIds?: string[]) => {
    if (!text.trim() || !selectedId) return;
    const shouldAutoTitle = pendingAutoTitle.current.has(selectedId);
    if (shouldAutoTitle) pendingAutoTitle.current.delete(selectedId);
    // Prepend staged code selections as <selected-code> blocks — pinned
    // (Ctrl/Cmd+I) plus the current live editor selection (deduped) — then
    // clear ALL staged context (file refs are already inlined by the
    // Composer as <file_refs>; clear() also drops the live selection).
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
    const prefix = formatSelections(allSels);
    const outgoing = prefix ? `${prefix}\n\n${text}` : text;
    st.clear(projectId);
    await sendMessage(outgoing, async () => {
      refetchSession();
      if (shouldAutoTitle) {
        apiPost<{ title: string }>(`/coder/sessions/${selectedId}/generate-title`, { content: text })
          .then(() => { refetchSessions(); window.dispatchEvent(new CustomEvent('coder:sessions-changed')); })
          .catch((err) => console.warn('[editor-chat] generate-title failed:', err));
      }
    }, { attachments: atts, agent, maxTurns, thinking, describeImages: settings.describeImages, selectedSkillIds });
  }, [selectedId, selections, projectId, sendMessage, refetchSession, refetchSessions, agent, maxTurns, thinking, settings.describeImages]);

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
    onPlanResponse: (approved, feedback) => respondToPlan(approved, feedback),
    onTasksResponse: (verdict) => respondToTasks(verdict),
    onToolApproval: (toolUseId, verdict) => respondToToolApproval(toolUseId, verdict),
  }), [answerQuestion, respondToPlan, respondToTasks, respondToToolApproval]);

  return {
    sessions: sessions ?? null, refetchSessions, selectedId, setSelectedId, createSession, creating,
    sessionData: sessionData ?? null, streaming, currentTurn, doneReason, error,
    liveTurnDuplicatedInHistory, tasksState, handlers, loadEarlierMessages, abort, handleSend,
    provider, model, setModel, agent, setAgent, maxTurns, setMaxTurns,
    temperature, setTemperature: handleTemperatureChange, onSwitchProvider,
    providerOptions, currentProviderModels, getModelsForProvider,
    thinking, setThinking, supportsThinking: providerSupportsThinking(provider, providerOptions, model),
    ...settings,
  };
}
