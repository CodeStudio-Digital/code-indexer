/**
 * Hook for consuming multiplexed SSE from a company session.
 *
 * Does NOT auto-connect on mount — call `start(message)` to begin the run
 * and start streaming, or `reattach()` to reconnect to an active run.
 */
import { useCallback, useRef, useState } from 'react';
import type { Usage } from './agent-stream/types.js';

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
  textChunks: string[];
  toolCalls: Array<{
    id: string;
    name: string;
    status: 'running' | 'done' | 'error';
    durationMs?: number;
  }>;
  status: 'idle' | 'running' | 'waiting_plan' | 'completed' | 'error';
  usage?: Usage;
  doneReason?: string;
}

export interface CompanyStreamState {
  connected: boolean;
  started: boolean;
  masterState: AgentStreamState | null;
  subordinateStates: Map<number, AgentStreamState>;
  boardMessages: BoardMessage[];
  error: string | null;
  userMessage: string | null;
  /** Set when Master calls submit_plan — needs human approval. */
  pendingMasterPlan: { plan: string } | null;
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
    error: null,
    userMessage: null,
    pendingMasterPlan: null,
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
    } else if (eventType === 'master_plan_posted') {
      const d = data as { plan: string };
      setState((prev) => ({ ...prev, pendingMasterPlan: { plan: d.plan } }));
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
      pendingMasterPlan: null,
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
   * Reattach to an active company session run.
   */
  const reattach = useCallback(async () => {
    if (!companySessionId) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState((prev) => ({ ...prev, connected: true, error: null }));

    try {
      const res = await fetch(`/api/company/sessions/${companySessionId}/attach`, {
        signal: ctrl.signal,
        headers: { Accept: 'text/event-stream' },
      });

      if (!res.ok) {
        setState((prev) => ({ ...prev, connected: false }));
        return;
      }

      if (res.body) {
        await consumeSSE(res.body.getReader());
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setState((prev) => ({ ...prev, connected: false }));
      }
    } finally {
      setState((prev) => ({ ...prev, connected: false }));
    }
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

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState({
      connected: false,
      started: false,
      masterState: null,
      subordinateStates: new Map(),
      boardMessages: [],
      error: null,
      userMessage: null,
      pendingMasterPlan: null,
    });
  }, []);

  return {
    ...state,
    start,
    reattach,
    abort,
    reset,
    respondToMasterPlan,
  };
}
