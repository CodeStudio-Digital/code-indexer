/**
 * Hook for consuming multiplexed SSE from a company session.
 *
 * Does NOT auto-connect on mount — call `start(message)` to begin the run
 * and start streaming, or `reattach()` to reconnect to an active run.
 */
import { useCallback, useRef, useState } from 'react';
import type { Usage } from './agent-stream/types.js';
import type { KanbanCardFull, KanbanComment, KanbanChecklistItem } from '../../../core/coder/company/types.js';

// ─── Types ─────────────────────────────────────────────────────

export interface BoardMessage {
  id: number;
  author_role: string;
  agent_run_id: number | null;
  kind: string;
  content: string;
  mentions: string[];
  created_at: string;
}

export interface AgentStreamState {
  role: string;
  agentRunId: number;
  coderSessionId?: number;
  textChunks: string[];
  toolCalls: Array<{
    id: string;
    name: string;
    status: 'running' | 'done' | 'error';
    durationMs?: number;
  }>;
  status: 'idle' | 'running' | 'working' | 'waiting' | 'waiting_plan' | 'waiting_question' | 'waiting_tasks' | 'reviewing' | 'blocked' | 'completed' | 'error' | 'aborted';
  statusMessage?: string;
  usage?: Usage;
  doneReason?: string;
}

export interface CompanyStreamState {
  connected: boolean;
  started: boolean;
  masterState: AgentStreamState | null;
  subordinateStates: Map<number, AgentStreamState>;
  boardMessages: BoardMessage[];
  kanbanCards: Map<number, KanbanCardFull>;
  error: string | null;
  userMessage: string | null;
  /** Set when Master calls submit_plan — needs human approval. */
  pendingMasterPlan: { plan: string } | null;
  /** Set when Master calls ask_user — needs human answer. */
  pendingMasterQuestion: {
    question: string;
    options?: Array<{ label: string; value: string }>;
    allowFreeform?: boolean;
  } | null;
}

interface AgentEvent {
  agent: string;
  agentRunId: number;
  event: string;
  data: unknown;
}

// ─── Hook ──────────────────────────────────────────────────────

export function useCompanyStream(companySessionId: number | null) {
  const [state, setState] = useState<CompanyStreamState>({
    connected: false,
    started: false,
    masterState: null,
    subordinateStates: new Map(),
    boardMessages: [],
    kanbanCards: new Map(),
    error: null,
    userMessage: null,
    pendingMasterPlan: null,
    pendingMasterQuestion: null,
  });

  const abortRef = useRef<AbortController | null>(null);

  // Shared SSE parser
  function consumeSSE(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = '';

    async function pump(): Promise<void> {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        let currentEvent = '';
        let currentData = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            currentData = line.slice(6);
          } else if (line === '' && currentEvent && currentData) {
            try {
              handleSSEEvent(currentEvent, JSON.parse(currentData));
            } catch { /* ignore parse errors */ }
            currentEvent = '';
            currentData = '';
          }
        }
      }
    }

    return pump();
  }

  function handleSSEEvent(eventType: string, data: unknown) {
    if (eventType === 'agent_event') {
      handleAgentEvent(data as AgentEvent);
    } else if (eventType === 'board_entry') {
      const entry = data as BoardMessage;
      setState((prev) => ({
        ...prev,
        boardMessages: [...prev.boardMessages, entry],
      }));
    } else if (eventType === 'subordinate_plan_posted') {
      const sp = data as { agentRunId: number };
      setState((prev) => {
        const subs = new Map(prev.subordinateStates);
        const existing = subs.get(sp.agentRunId);
        if (existing) {
          subs.set(sp.agentRunId, { ...existing, status: 'waiting_plan' });
        }
        return { ...prev, subordinateStates: subs };
      });
    } else if (eventType === 'subordinate_question_posted') {
      const sq = data as { agentRunId: number };
      setState((prev) => {
        const subs = new Map(prev.subordinateStates);
        const existing = subs.get(sq.agentRunId);
        if (existing) {
          subs.set(sq.agentRunId, { ...existing, status: 'waiting_question' });
        }
        return { ...prev, subordinateStates: subs };
      });
    } else if (eventType === 'subordinate_tasks_posted') {
      const st = data as { agentRunId: number };
      setState((prev) => {
        const subs = new Map(prev.subordinateStates);
        const existing = subs.get(st.agentRunId);
        if (existing) {
          subs.set(st.agentRunId, { ...existing, status: 'waiting_tasks' });
        }
        return { ...prev, subordinateStates: subs };
      });
    } else if (eventType === 'agent_status') {
      const d = data as { agentRunId: number; role: string; status: string; message: string };
      setState((prev) => {
        const isMaster = d.role === 'master';
        if (isMaster && prev.masterState) {
          return { ...prev, masterState: { ...prev.masterState, status: d.status as AgentStreamState['status'], statusMessage: d.message } };
        }
        const subs = new Map(prev.subordinateStates);
        const existing = subs.get(d.agentRunId);
        if (existing) {
          subs.set(d.agentRunId, { ...existing, status: d.status as AgentStreamState['status'], statusMessage: d.message });
        }
        return { ...prev, subordinateStates: subs };
      });
    } else if (eventType === 'master_plan_posted') {
      const d = data as { plan: string };
      setState((prev) => ({ ...prev, pendingMasterPlan: { plan: d.plan } }));
    } else if (eventType === 'master_question_posted') {
      const d = data as {
        question: string;
        options?: Array<{ label: string; value: string }>;
        allowFreeform?: boolean;
      };
      setState((prev) => ({ ...prev, pendingMasterQuestion: d }));
    } else if (eventType.startsWith('kanban_')) {
      handleKanbanEvent(eventType, data);
    } else if (eventType === 'session_idle') {
      // Session is waiting for user input — master finished but bus is alive.
      // Keep connected=true so the SSE stream survives and the user can send
      // follow-up messages that resurrect the master.
      setState((prev) => ({
        ...prev,
        masterState: prev.masterState
          ? { ...prev.masterState, status: 'waiting', statusMessage: 'Waiting for your input' }
          : prev.masterState,
      }));
    } else if (eventType === 'error') {
      const d = data as { error?: string };
      setState((prev) => ({
        ...prev,
        connected: false,
        error: d.error ?? 'Unknown error from server',
      }));
    } else if (eventType === 'done') {
      setState((prev) => ({ ...prev, connected: false }));
    }
  }

  function handleAgentEvent(ae: AgentEvent) {
    setState((prev) => {
      const isMaster = ae.agent === 'master';

      const getOrCreate = (): AgentStreamState => {
        if (isMaster && prev.masterState) return prev.masterState;
        if (!isMaster && prev.subordinateStates.has(ae.agentRunId)) {
          return prev.subordinateStates.get(ae.agentRunId)!;
        }
        return {
          role: ae.agent,
          agentRunId: ae.agentRunId,
          textChunks: [],
          toolCalls: [],
          status: 'running',
        };
      };

      let agentState = getOrCreate();

      switch (ae.event) {
        case 'text_delta': {
          const d = ae.data as { text: string };
          agentState = { ...agentState, textChunks: [...agentState.textChunks, d.text] };
          break;
        }
        case 'tool_call_start': {
          const d = ae.data as { id: string; name: string };
          agentState = {
            ...agentState,
            toolCalls: [...agentState.toolCalls, { id: d.id, name: d.name, status: 'running' }],
          };
          break;
        }
        case 'tool_call_result': {
          const d = ae.data as { id: string; duration_ms?: number };
          agentState = {
            ...agentState,
            toolCalls: agentState.toolCalls.map((tc) =>
              tc.id === d.id ? { ...tc, status: 'done' as const, durationMs: d.duration_ms } : tc,
            ),
          };
          break;
        }
        case 'message_complete': {
          const d = ae.data as { usage?: Usage };
          if (d.usage) agentState = { ...agentState, usage: d.usage };
          agentState = { ...agentState, textChunks: [] };
          break;
        }
        case 'done': {
          const d = ae.data as { reason: string };
          agentState = {
            ...agentState,
            status: d.reason === 'completed' ? 'completed' : 'error',
            doneReason: d.reason,
          };
          break;
        }
        default:
          break;
      }

      if (isMaster) {
        return { ...prev, masterState: agentState };
      }
      const subs = new Map(prev.subordinateStates);
      subs.set(ae.agentRunId, agentState);
      return { ...prev, subordinateStates: subs };
    });
  }

  function handleKanbanEvent(eventType: string, data: unknown) {
    setState((prev) => {
      const cards = new Map(prev.kanbanCards);

      switch (eventType) {
        case 'kanban_card_created': {
          const card = data as KanbanCardFull;
          cards.set(card.id, card);
          break;
        }
        case 'kanban_card_moved': {
          const d = data as { cardId: number; fromColumn: string; toColumn: string; position: number };
          const existing = cards.get(d.cardId);
          if (existing) {
            cards.set(d.cardId, {
              ...existing,
              column: d.toColumn as KanbanCardFull['column'],
              position: d.position,
            });
          }
          break;
        }
        case 'kanban_card_updated': {
          const d = data as { cardId: number; patch: Record<string, unknown> };
          const existing = cards.get(d.cardId);
          if (existing) {
            cards.set(d.cardId, { ...existing, ...d.patch });
          }
          break;
        }
        case 'kanban_card_deleted': {
          const d = data as { cardId: number };
          cards.delete(d.cardId);
          break;
        }
        case 'kanban_comment_added': {
          const d = data as { cardId: number; comment: KanbanComment };
          const existing = cards.get(d.cardId);
          if (existing) {
            cards.set(d.cardId, {
              ...existing,
              comments: [...existing.comments, d.comment],
            });
          }
          break;
        }
        case 'kanban_checklist_updated': {
          const d = data as { cardId: number; items: KanbanChecklistItem[] };
          const existing = cards.get(d.cardId);
          if (existing) {
            const updated = [...existing.checklist];
            for (const item of d.items) {
              const idx = updated.findIndex((i) => i.id === item.id);
              if (idx >= 0) updated[idx] = item;
              else updated.push(item);
            }
            cards.set(d.cardId, { ...existing, checklist: updated });
          }
          break;
        }
        case 'kanban_dependency_added': {
          const d = data as { cardId: number; dependsOnId: number };
          const existing = cards.get(d.cardId);
          if (existing) {
            // Check if the dependency target is not done
            const depCard = cards.get(d.dependsOnId);
            const blockedBy = [...existing.blocked_by];
            if (depCard && depCard.column !== 'done' && !blockedBy.includes(d.dependsOnId)) {
              blockedBy.push(d.dependsOnId);
            }
            cards.set(d.cardId, {
              ...existing,
              dependencies: [...existing.dependencies, { id: 0, card_id: d.cardId, depends_on_id: d.dependsOnId, created_at: new Date().toISOString() }],
              blocked_by: blockedBy,
            });
          }
          break;
        }
        case 'kanban_dependency_removed': {
          const d = data as { cardId: number; dependsOnId: number };
          const existing = cards.get(d.cardId);
          if (existing) {
            cards.set(d.cardId, {
              ...existing,
              dependencies: existing.dependencies.filter((dep) => dep.depends_on_id !== d.dependsOnId),
              blocked_by: existing.blocked_by.filter((id) => id !== d.dependsOnId),
            });
          }
          break;
        }
        case 'kanban_agent_assigned': {
          const d = data as { cardId: number; agentRunId: number; role: string };
          const existing = cards.get(d.cardId);
          if (existing) {
            cards.set(d.cardId, {
              ...existing,
              agents: [...existing.agents, {
                id: 0,
                card_id: d.cardId,
                agent_run_id: d.agentRunId,
                role: d.role,
                assigned_at: new Date().toISOString(),
                unassigned_at: null,
              }],
            });
          }
          break;
        }
        case 'kanban_agent_unassigned': {
          const d = data as { cardId: number; agentRunId: number };
          const existing = cards.get(d.cardId);
          if (existing) {
            cards.set(d.cardId, {
              ...existing,
              agents: existing.agents.map((a) =>
                a.agent_run_id === d.agentRunId && !a.unassigned_at
                  ? { ...a, unassigned_at: new Date().toISOString() }
                  : a
              ),
            });
          }
          break;
        }
      }

      return { ...prev, kanbanCards: cards };
    });
  }

  /**
   * Start the company session — sends user message and opens SSE stream.
   */
  const start = useCallback(async (userMessage: string) => {
    if (!companySessionId) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState({
      started: true,
      connected: true,
      userMessage,
      error: null,
      masterState: null,
      subordinateStates: new Map(),
      boardMessages: [],
      kanbanCards: new Map(),
      pendingMasterPlan: null,
      pendingMasterQuestion: null,
    });

    try {
      const res = await fetch(`/api/company/sessions/${companySessionId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_message: userMessage }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => 'Unknown error');
        setState((prev) => ({ ...prev, connected: false, error: `Start failed: ${errorBody}` }));
        return;
      }

      if (!res.body) {
        setState((prev) => ({ ...prev, connected: false, error: 'No response body' }));
        return;
      }

      await consumeSSE(res.body.getReader());
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setState((prev) => ({
          ...prev,
          error: `Connection error: ${(e as Error).message}`,
        }));
      }
    } finally {
      setState((prev) => ({ ...prev, connected: false }));
    }
  }, [companySessionId]);

  /**
   * Resume a completed/paused company session. Unlike start(), this
   * preserves the master's conversation history and the board entries.
   */
  const resume = useCallback(async (message: string) => {
    if (!companySessionId) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Don't clear boardMessages or agent states — preserve existing context
    setState((prev) => ({
      ...prev,
      started: true,
      connected: true,
      error: null,
      pendingMasterPlan: null,
      pendingMasterQuestion: null,
    }));

    try {
      const res = await fetch(`/api/company/sessions/${companySessionId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => 'Unknown error');
        setState((prev) => ({ ...prev, connected: false, error: `Resume failed: ${errorBody}` }));
        return;
      }

      if (!res.body) {
        setState((prev) => ({ ...prev, connected: false, error: 'No response body' }));
        return;
      }

      await consumeSSE(res.body.getReader());
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setState((prev) => ({
          ...prev,
          error: `Connection error: ${(e as Error).message}`,
        }));
      }
    } finally {
      setState((prev) => ({ ...prev, connected: false }));
    }
  }, [companySessionId]);

  /**
   * Load final session state from DB when SSE stream is unavailable.
   * This covers the case where the session completed while the user
   * was on another page — we load board + agent runs from persisted data.
   */
  const loadFinalStateFromDB = useCallback(async () => {
    if (!companySessionId) return;
    try {
      const res = await fetch(`/api/company/sessions/${companySessionId}`);
      if (!res.ok) return;
      const data = await res.json();
      setState((prev) => {
        // Build board messages from DB
        const dbBoard: BoardMessage[] = (data.recentBoard ?? []).map((b: { id: number; author_role: string; agent_run_id: number | null; kind: string; content: string; mentions_json: string; created_at: string }) => ({
          id: b.id,
          author_role: b.author_role,
          agent_run_id: b.agent_run_id,
          kind: b.kind,
          content: b.content,
          mentions: JSON.parse(b.mentions_json || '[]'),
          created_at: b.created_at,
        }));
        // Build agent states from DB
        const subs = new Map<number, AgentStreamState>();
        let master: AgentStreamState | null = prev.masterState;
        for (const run of data.agentRuns ?? []) {
          const agentState: AgentStreamState = {
            role: run.role,
            agentRunId: run.id,
            coderSessionId: run.coder_session_id,
            textChunks: [],
            toolCalls: [],
            status: run.status as AgentStreamState['status'],
            statusMessage: run.status_message,
          };
          if (run.role === 'master') {
            master = agentState;
          } else {
            subs.set(run.id, agentState);
          }
        }
        return {
          ...prev,
          started: true,
          boardMessages: dbBoard.length > 0 ? dbBoard : prev.boardMessages,
          masterState: master,
          subordinateStates: subs.size > 0 ? subs : prev.subordinateStates,
        };
      });
    } catch { /* ignore fetch errors */ }
  }, [companySessionId]);

  /**
   * Reattach to an active company session run.
   * Retries up to 3 times with exponential backoff.
   * If all retries fail, falls back to loading final state from DB.
   */
  const reattach = useCallback(async () => {
    if (!companySessionId) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState((prev) => ({ ...prev, started: true, connected: true, error: null }));

    const maxRetries = 3;
    const baseDelayMs = 1000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (ctrl.signal.aborted) break;

      // Exponential backoff on retries
      if (attempt > 0) {
        await new Promise<void>((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 1)));
        if (ctrl.signal.aborted) break;
      }

      try {
        const res = await fetch(`/api/company/sessions/${companySessionId}/attach`, {
          signal: ctrl.signal,
          headers: { Accept: 'text/event-stream' },
        });

        if (res.ok && res.body) {
          // Connected successfully — consume the stream
          await consumeSSE(res.body.getReader());
          // Stream ended naturally (bus closed) — load final state
          await loadFinalStateFromDB();
          setState((prev) => ({ ...prev, connected: false }));
          return;
        }

        // 404 = bus ended or orchestrator gone — retry in case of timing
        if (res.status === 404 && attempt < maxRetries - 1) {
          continue;
        }

        // Non-retryable error or last attempt
        if (!res.ok) {
          // Fall through to final fallback below
          break;
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        if (attempt < maxRetries - 1) continue;
        break;
      }
    }

    // All retries exhausted — load final state from DB
    await loadFinalStateFromDB();
    setState((prev) => ({ ...prev, connected: false }));
  }, [companySessionId]);

  const abort = useCallback(async () => {
    if (!companySessionId) return;
    abortRef.current?.abort();
    try {
      await fetch(`/api/company/sessions/${companySessionId}/abort`, { method: 'POST' });
    } catch { /* ignore */ }
    setState((prev) => ({ ...prev, connected: false }));
  }, [companySessionId]);

  const respondToMasterPlan = useCallback(async (approved: boolean, feedback?: string) => {
    if (!companySessionId) return;
    try {
      await fetch(`/api/company/sessions/${companySessionId}/plan-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved, feedback }),
      });
      setState((prev) => ({ ...prev, pendingMasterPlan: null }));
    } catch (e) {
      console.error('Failed to respond to master plan:', e);
    }
  }, [companySessionId]);

  const sendMessage = useCallback(async (message: string) => {
    if (!companySessionId) return;
    try {
      const res = await fetch(`/api/company/sessions/${companySessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const errorMsg = res.status === 404
          ? 'Session is no longer active. Start a new session or reload the page.'
          : `Failed to send message (${res.status}): ${body}`;
        setState((prev) => ({ ...prev, error: errorMsg }));
      }
    } catch (e) {
      console.error('Failed to send message to master:', e);
      setState((prev) => ({ ...prev, error: `Connection error: ${(e as Error).message}` }));
    }
  }, [companySessionId]);

  const respondToMasterQuestion = useCallback(async (answer: string) => {
    if (!companySessionId) return;
    try {
      const res = await fetch(`/api/company/sessions/${companySessionId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      });
      if (res.ok) {
        setState((prev) => ({ ...prev, pendingMasterQuestion: null }));
      } else {
        const body = await res.text().catch(() => '');
        const errorMsg = res.status === 404
          ? 'Session is no longer active. Your answer could not be delivered.'
          : `Failed to answer (${res.status}): ${body}`;
        setState((prev) => ({ ...prev, error: errorMsg }));
      }
    } catch (e) {
      console.error('Failed to answer master question:', e);
      setState((prev) => ({ ...prev, error: `Connection error: ${(e as Error).message}` }));
    }
  }, [companySessionId]);

  const switchProvider = useCallback(async (
    provider: string,
    model?: string,
    roleAssignments?: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[] }>,
  ) => {
    if (!companySessionId) return;
    try {
      const res = await fetch(`/api/company/sessions/${companySessionId}/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model, role_assignments: roleAssignments }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        setState((prev) => ({ ...prev, error: `Switch failed: ${body}` }));
      }
    } catch (e) {
      setState((prev) => ({ ...prev, error: `Switch error: ${(e as Error).message}` }));
    }
  }, [companySessionId]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState({
      connected: false,
      started: false,
      masterState: null,
      subordinateStates: new Map(),
      boardMessages: [],
      kanbanCards: new Map(),
      error: null,
      userMessage: null,
      pendingMasterPlan: null,
      pendingMasterQuestion: null,
    });
  }, []);

  return {
    ...state,
    start,
    resume,
    reattach,
    abort,
    reset,
    sendMessage,
    switchProvider,
    respondToMasterPlan,
    respondToMasterQuestion,
  };
}
