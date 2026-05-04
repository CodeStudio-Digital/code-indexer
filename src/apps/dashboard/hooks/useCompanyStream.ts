/**
 * Hook for consuming multiplexed SSE from a company session.
 *
 * Does NOT auto-connect on mount — call `start(message)` to begin the run
 * and start streaming, or `reattach()` to reconnect to an active run.
 *
 * Internals use the shared ReconnectingSSEClient so transport concerns
 * (reconnect with Last-Event-ID, heartbeat handling, backoff) are
 * implemented once and reused across hooks.
 */
import { useCallback, useRef, useState } from 'react';
import type { Usage, AgentAttachment } from './agent-stream/types.js';
import type { KanbanCardFull, KanbanComment, KanbanChecklistItem, MasterPrompt } from '../../../core/coder/company/types.js';
import { ReconnectingSSEClient } from '../../../shared/sse/ReconnectingSSEClient.js';
import type { SSEEvent } from '../../../shared/sse/SSEFramer.js';

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

export interface FallbackNotice {
  at: number;
  agent: string;
  from?: { provider?: string; model?: string };
  to?: { provider?: string; model?: string };
  error?: string;
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
  status: 'idle' | 'running' | 'working' | 'waiting' | 'waiting_plan' | 'waiting_question' | 'waiting_tasks' | 'reviewing' | 'blocked' | 'completed' | 'error' | 'aborted' | 'interrupted';
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
  /**
   * All master↔human prompts (ask_user / submit_plan) for this session,
   * keyed by their persistent DB id. Survives navigation/reload because
   * it's rehydrated from the DB on reattach. Status (pending/answered/
   * cancelled) is updated in place via SSE.
   */
  masterPrompts: Map<number, MasterPrompt>;
  /** Master error details when session_idle reports `master_error`. */
  masterErrorDetail: string | null;
  /** Recent fallback activations (most recent first, max 5 kept). */
  fallbackNotices: FallbackNotice[];
}

interface AgentEvent {
  agent: string;
  agentRunId: number;
  event: string;
  data: unknown;
}

// ─── Hook ──────────────────────────────────────────────────────

const INITIAL_STATE: CompanyStreamState = {
  connected: false,
  started: false,
  masterState: null,
  subordinateStates: new Map(),
  boardMessages: [],
  kanbanCards: new Map(),
  error: null,
  userMessage: null,
  masterPrompts: new Map(),
  masterErrorDetail: null,
  fallbackNotices: [],
};

export function useCompanyStream(companySessionId: number | null) {
  const [state, setState] = useState<CompanyStreamState>(INITIAL_STATE);

  const abortRef = useRef<AbortController | null>(null);
  /** Last SSE event id seen — used for Last-Event-ID on reconnect/reattach. */
  const lastSeenSeqRef = useRef<number>(-1);
  /** True once a terminal event arrived — suppresses auto-reconnect. */
  const receivedDoneRef = useRef<boolean>(false);

  // ─── Event handlers ──────────────────────────────────────────

  function handleSSEEvent(eventType: string, data: unknown) {
    if (eventType === 'agent_event') {
      handleAgentEvent(data as AgentEvent);
    } else if (eventType === 'board_entry') {
      const entry = data as BoardMessage;
      setState((prev) => {
        // Idempotent: dedup by entry.id so SSE replay doesn't duplicate.
        if (prev.boardMessages.some((m) => m.id === entry.id)) return prev;
        return { ...prev, boardMessages: [...prev.boardMessages, entry] };
      });
    } else if (eventType === 'subordinate_plan_posted') {
      const sp = data as { agentRunId: number };
      setState((prev) => {
        const subs = new Map(prev.subordinateStates);
        const existing = subs.get(sp.agentRunId);
        if (existing) subs.set(sp.agentRunId, { ...existing, status: 'waiting_plan' });
        return { ...prev, subordinateStates: subs };
      });
    } else if (eventType === 'subordinate_question_posted') {
      const sq = data as { agentRunId: number };
      setState((prev) => {
        const subs = new Map(prev.subordinateStates);
        const existing = subs.get(sq.agentRunId);
        if (existing) subs.set(sq.agentRunId, { ...existing, status: 'waiting_question' });
        return { ...prev, subordinateStates: subs };
      });
    } else if (eventType === 'subordinate_tasks_posted') {
      const st = data as { agentRunId: number };
      setState((prev) => {
        const subs = new Map(prev.subordinateStates);
        const existing = subs.get(st.agentRunId);
        if (existing) subs.set(st.agentRunId, { ...existing, status: 'waiting_tasks' });
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
    } else if (
      eventType === 'master_plan_posted' ||
      eventType === 'master_question_posted' ||
      eventType === 'master_plan_resolved' ||
      eventType === 'master_question_resolved' ||
      eventType === 'master_prompt_cancelled'
    ) {
      // All master_prompt events carry { prompt: MasterPrompt }. Upsert by
      // id — idempotent across SSE replay so already-answered prompts
      // never reopen, and rehydration on reattach merges cleanly.
      const d = data as { prompt?: MasterPrompt };
      if (d.prompt) {
        const incoming = d.prompt;
        setState((prev) => {
          const next = new Map(prev.masterPrompts);
          next.set(incoming.id, incoming);
          return { ...prev, masterPrompts: next };
        });
      }
    } else if (eventType.startsWith('kanban_')) {
      handleKanbanEvent(eventType, data);
    } else if (eventType === 'session_idle') {
      // Session is waiting for user input — master finished but bus is alive.
      const d = data as { reason?: string; errorDetail?: string };
      setState((prev) => ({
        ...prev,
        masterState: prev.masterState
          ? {
              ...prev.masterState,
              status: d.reason === 'master_error' ? 'error' : 'waiting',
              statusMessage: d.errorDetail || (d.reason === 'master_error' ? 'Master failed' : 'Waiting for your input'),
            }
          : prev.masterState,
        masterErrorDetail: d.reason === 'master_error' ? (d.errorDetail ?? 'unknown') : null,
      }));
    } else if (eventType === 'error') {
      const d = data as { error?: string };
      receivedDoneRef.current = true; // terminal — do not auto-reconnect
      setState((prev) => ({
        ...prev,
        connected: false,
        error: d.error ?? 'Unknown error from server',
      }));
    } else if (eventType === 'sandbox.file_changed') {
      // Builder mode: an agent just wrote/edited a file in the sandbox.
      // Broadcast a scoped window event so `BuilderView`'s PreviewPanel
      // can force an iframe reload. Keeps this hook's state shape
      // unchanged and avoids plumbing a new return value up to callers
      // that don't care about the preview pane.
      if (typeof window !== 'undefined' && companySessionId != null) {
        window.dispatchEvent(
          new CustomEvent(`sandbox:file-changed:${companySessionId}`, { detail: data }),
        );
      }
    } else if (eventType === 'done') {
      receivedDoneRef.current = true;
      setState((prev) => ({ ...prev, connected: false }));
    }
  }

  function handleAgentEvent(ae: AgentEvent) {
    // fallback_activated — surface as a notice for the UI to toast.
    if (ae.event === 'fallback_activated') {
      const d = ae.data as {
        from?: { provider?: string; model?: string };
        to?: { provider?: string; model?: string };
        error?: string;
      };
      setState((prev) => ({
        ...prev,
        fallbackNotices: [
          { at: Date.now(), agent: ae.agent, from: d.from, to: d.to, error: d.error },
          ...prev.fallbackNotices,
        ].slice(0, 5),
      }));
      return;
    }

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
          // Dedup on replay: don't add the same tool_call twice.
          if (agentState.toolCalls.some((tc) => tc.id === d.id)) break;
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
          cards.set(card.id, card); // Map.set is idempotent (upsert)
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
            // Dedup by comment.id so replay is safe.
            if (existing.comments.some((c) => c.id === d.comment.id)) break;
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
            // Dedup: skip if the dependency edge already exists.
            if (existing.dependencies.some((dep) => dep.depends_on_id === d.dependsOnId)) break;
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
            // Dedup: a (card_id, agent_run_id) pair with unassigned_at=null
            // already exists means assignment already applied.
            const alreadyAssigned = existing.agents.some(
              (a) => a.agent_run_id === d.agentRunId && !a.unassigned_at,
            );
            if (alreadyAssigned) break;
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

  // ─── Transport bridge ────────────────────────────────────────

  const onSSEEvent = useCallback((ev: SSEEvent) => {
    if (ev.id !== undefined && ev.id > lastSeenSeqRef.current) {
      lastSeenSeqRef.current = ev.id;
    }
    let parsed: unknown = null;
    if (ev.data) {
      try { parsed = JSON.parse(ev.data); } catch { parsed = null; }
    }
    handleSSEEvent(ev.event, parsed);
  }, []);

  // ─── Data loaders (fallback + reattach kanban sync) ──────────

  const loadKanbanFromDB = useCallback(async () => {
    if (!companySessionId) return;
    try {
      const res = await fetch(`/api/company/sessions/${companySessionId}/kanban?full=true`);
      if (!res.ok) return;
      const cards = (await res.json()) as KanbanCardFull[];
      if (!Array.isArray(cards)) return;
      setState((prev) => ({
        ...prev,
        kanbanCards: new Map(cards.map((c) => [c.id, c])),
      }));
    } catch {
      /* best-effort — ignore */
    }
  }, [companySessionId]);

  /**
   * Load final session state from DB when SSE stream is unavailable.
   * Covers the case where the session completed while the user was on
   * another page — load board + agent runs + kanban from persisted data.
   */
  const loadFinalStateFromDB = useCallback(async () => {
    if (!companySessionId) return;
    try {
      const res = await fetch(`/api/company/sessions/${companySessionId}`);
      if (!res.ok) return;
      const data = await res.json();
      setState((prev) => {
        // Build board messages from DB (dedup by id against any existing)
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
        // Master prompts — rehydrate from DB so questions/plans persist
        // across navigation/reload, with their resolution state intact.
        const dbPrompts = (data.masterPrompts ?? []) as MasterPrompt[];
        const mergedPrompts = new Map(prev.masterPrompts);
        for (const p of dbPrompts) mergedPrompts.set(p.id, p);

        return {
          ...prev,
          started: true,
          boardMessages: dbBoard.length > 0 ? dbBoard : prev.boardMessages,
          masterState: master,
          subordinateStates: subs.size > 0 ? subs : prev.subordinateStates,
          masterPrompts: mergedPrompts,
        };
      });
    } catch { /* ignore fetch errors */ }
    // Kanban is a separate endpoint — always fetch it too.
    await loadKanbanFromDB();
  }, [companySessionId, loadKanbanFromDB]);

  // ─── Connect helpers ─────────────────────────────────────────

  /**
   * Open an SSE stream via ReconnectingSSEClient. Wrapped so each
   * entry point (start, resume, reattach) shares the same transport
   * logic: Last-Event-ID, auto-reconnect on drop, heartbeat handling.
   */
  async function openStream(opts: {
    url: string;
    method: 'GET' | 'POST';
    body?: unknown;
    /** Called on reconnect to refresh kanban state after missed window. */
    onReconnect?: (attempt: number) => void | Promise<void>;
    /** If provided and returns true, the error is swallowed silently. */
    suppressError?: (err: Error) => boolean;
  }): Promise<void> {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    receivedDoneRef.current = false;

    const client = new ReconnectingSSEClient({
      url: opts.url,
      method: opts.method,
      body: opts.body,
      onEvent: onSSEEvent,
      getLastEventId: () => lastSeenSeqRef.current,
      signal: ctrl.signal,
      onReconnect: async (attempt) => {
        // On every reconnect, ensure kanban is current — the replay from
        // Last-Event-ID covers buffered events but not state that was
        // stored to DB during our disconnect window.
        await loadKanbanFromDB();
        await opts.onReconnect?.(attempt);
      },
      isTerminal: (ev) => ev.event === 'done' || ev.event === 'error',
    });

    try {
      await client.run();
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      if (opts.suppressError?.(e as Error)) return;
      setState((prev) => ({
        ...prev,
        error: `Connection error: ${(e as Error).message}`,
      }));
    } finally {
      setState((prev) => ({ ...prev, connected: false }));
    }
  }

  // ─── Public actions ──────────────────────────────────────────

  const start = useCallback(async (userMessage: string, attachments?: AgentAttachment[]) => {
    if (!companySessionId) return;
    lastSeenSeqRef.current = -1;
    setState({
      ...INITIAL_STATE,
      started: true,
      connected: true,
      userMessage,
    });
    await openStream({
      url: `/api/company/sessions/${companySessionId}/start`,
      method: 'POST',
      body: { user_message: userMessage, attachments: attachments?.length ? attachments : undefined },
    });
  }, [companySessionId]);

  const resume = useCallback(async (message: string, attachments?: AgentAttachment[]) => {
    if (!companySessionId) return;
    // Don't clear boardMessages or agent states — preserve existing context
    setState((prev) => ({
      ...prev,
      started: true,
      connected: true,
      error: null,
      masterErrorDetail: null,
    }));
    await openStream({
      url: `/api/company/sessions/${companySessionId}/resume`,
      method: 'POST',
      body: { message, attachments: attachments?.length ? attachments : undefined },
    });
  }, [companySessionId]);

  /**
   * Reattach to an active company session run. The ReconnectingSSEClient
   * handles its own retries internally via backoff; if the initial connect
   * fails (e.g., orchestrator GC'd), we fall back to loading final state
   * from DB so the UI still shows the session context.
   */
  const reattach = useCallback(async () => {
    if (!companySessionId) return;
    setState((prev) => ({ ...prev, started: true, connected: true, error: null }));

    // Always refresh kanban on reattach — we may have missed events while
    // disconnected (events survive in the ring buffer but only up to cap).
    await loadKanbanFromDB();

    try {
      await openStream({
        url: `/api/company/sessions/${companySessionId}/attach`,
        method: 'GET',
        suppressError: (e) => e.message === 'HTTP 404',
      });
    } finally {
      // Stream ended — either naturally (done) or after exhausting retries.
      // Load final state from DB so the UI reflects completion/pause state.
      await loadFinalStateFromDB();
    }
  }, [companySessionId, loadFinalStateFromDB, loadKanbanFromDB]);

  const abort = useCallback(async () => {
    if (!companySessionId) return;
    abortRef.current?.abort();
    try {
      await fetch(`/api/company/sessions/${companySessionId}/abort`, { method: 'POST' });
    } catch { /* ignore */ }
    setState((prev) => ({ ...prev, connected: false }));
  }, [companySessionId]);

  const respondToMasterPlan = useCallback(async (
    promptId: number,
    approved: boolean,
    feedback?: string,
  ) => {
    if (!companySessionId) return;
    try {
      const res = await fetch(`/api/company/sessions/${companySessionId}/plan-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved, feedback, prompt_id: promptId }),
      });
      if (res.ok) {
        const body = await res.json().catch(() => null) as { prompt?: MasterPrompt } | null;
        if (body?.prompt) {
          setState((prev) => {
            const next = new Map(prev.masterPrompts);
            next.set(body.prompt!.id, body.prompt!);
            return { ...prev, masterPrompts: next };
          });
        }
      } else if (res.status === 409) {
        // Already resolved/cancelled — silent: the SSE event already
        // updated our local state, no error to surface to the user.
      } else {
        const body = await res.text().catch(() => '');
        setState((prev) => ({ ...prev, error: `Failed to respond to plan (${res.status}): ${body}` }));
      }
    } catch (e) {
      console.error('Failed to respond to master plan:', e);
    }
  }, [companySessionId]);

  const sendMessage = useCallback(async (message: string, attachments?: AgentAttachment[]) => {
    if (!companySessionId) return;
    try {
      const res = await fetch(`/api/company/sessions/${companySessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, attachments: attachments?.length ? attachments : undefined }),
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

  const respondToMasterQuestion = useCallback(async (promptId: number, answer: string) => {
    if (!companySessionId) return;
    try {
      const res = await fetch(`/api/company/sessions/${companySessionId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer, prompt_id: promptId }),
      });
      if (res.ok) {
        const body = await res.json().catch(() => null) as { prompt?: MasterPrompt } | null;
        if (body?.prompt) {
          setState((prev) => {
            const next = new Map(prev.masterPrompts);
            next.set(body.prompt!.id, body.prompt!);
            return { ...prev, masterPrompts: next };
          });
        }
      } else if (res.status === 409) {
        // Already resolved (e.g. session ended, or answered in another tab) —
        // the SSE event will reconcile state. No error to user.
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
    lastSeenSeqRef.current = -1;
    receivedDoneRef.current = false;
    setState(INITIAL_STATE);
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
