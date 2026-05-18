/**
 * Hook for consuming the multiplexed SSE stream of a company session.
 *
 * Phase 0: the hook owns SSE transport (ReconnectingSSEClient + the abort
 * signal + the last-event-id ref) but delegates ALL state to the
 * `company` zustand store. Each SSE event is forwarded to a slice action;
 * the hook reads state back through selectors. This kills the duplicated
 * kanban Map that used to live in this hook's local state.
 *
 * Phase 2 will move SSE ownership out of React entirely (single client
 * per session managed by `state/company/sseConnection.ts`) and replace
 * the `kanban_*` REST refetch fallbacks with pure SSE invalidation.
 */
import { useCallback, useRef } from 'react';
import { ReconnectingSSEClient } from '@mcp/shared/sse/ReconnectingSSEClient.js';
import type { SSEEvent } from '@mcp/shared/sse/SSEFramer.js';
import type { MasterPrompt } from '@mcp/company-contracts';

import type { AgentAttachment } from './agent-stream/types.js';
import { useCompanyStore, selectStream } from '../state/company/index.js';
import type { DriveFileMeta } from '../state/company/driveSlice.js';
import type {
  AgentStreamState,
  BoardMessage,
} from '../state/company/types.js';
import type { AgentEventEnvelope } from '../state/company/stream-handlers/agentEvent.js';
import type {
  AgentStatusPayload,
  SessionIdlePayload,
} from '../state/company/stream-handlers/agentStatusEvent.js';

// Re-export client state types so legacy consumers keep their imports.
export type { AgentStreamState, BoardMessage, FallbackNotice } from '../state/company/types.js';

export function useCompanyStream(companySessionId: number | null) {
  // ─── Selectors ───────────────────────────────────────────────
  const stream = useCompanyStore((s) => selectStream(s, companySessionId));

  // ─── Action dispatchers (stable refs from zustand) ───────────
  const streamReset = useCompanyStore((s) => s.streamReset);
  const streamSetStarted = useCompanyStore((s) => s.streamSetStarted);
  const streamSetConnected = useCompanyStore((s) => s.streamSetConnected);
  const streamSetError = useCompanyStore((s) => s.streamSetError);
  const streamSetUserMessage = useCompanyStore((s) => s.streamSetUserMessage);
  const streamApplyAgentEvent = useCompanyStore((s) => s.streamApplyAgentEvent);
  const streamApplyAgentStatus = useCompanyStore((s) => s.streamApplyAgentStatus);
  const streamApplySubordinateWaiting = useCompanyStore((s) => s.streamApplySubordinateWaiting);
  const streamApplyBoardEntry = useCompanyStore((s) => s.streamApplyBoardEntry);
  const streamApplyMasterPrompt = useCompanyStore((s) => s.streamApplyMasterPrompt);
  const streamApplySessionIdle = useCompanyStore((s) => s.streamApplySessionIdle);
  const streamHydrateMasterPromptsAction = useCompanyStore((s) => s.streamHydrateMasterPrompts);
  const streamHydrateFromInitialFetch = useCompanyStore((s) => s.streamHydrateFromInitialFetch);
  const kanbanApplyEvent = useCompanyStore((s) => s.kanbanApplyEvent);
  const kanbanHydrate = useCompanyStore((s) => s.kanbanHydrate);
  const sandboxApplyFileChange = useCompanyStore((s) => s.sandboxApplyFileChange);
  const driveApplyAdded = useCompanyStore((s) => s.driveApplyAdded);
  const driveApplyUpdated = useCompanyStore((s) => s.driveApplyUpdated);
  const driveApplyDeleted = useCompanyStore((s) => s.driveApplyDeleted);
  const inboxBumpEventSeq = useCompanyStore((s) => s.inboxBumpEventSeq);

  // ─── Transport refs ──────────────────────────────────────────
  const abortRef = useRef<AbortController | null>(null);
  const lastSeenSeqRef = useRef<number>(-1);
  const receivedDoneRef = useRef<boolean>(false);

  // ─── SSE event dispatch ──────────────────────────────────────

  const handleSSEEvent = useCallback(
    (eventType: string, data: unknown) => {
      if (companySessionId == null) return;

      if (eventType === 'agent_event') {
        streamApplyAgentEvent(companySessionId, data as AgentEventEnvelope);
        return;
      }
      if (eventType === 'board_entry') {
        streamApplyBoardEntry(companySessionId, data as BoardMessage);
        return;
      }
      if (eventType === 'subordinate_plan_posted') {
        streamApplySubordinateWaiting(
          companySessionId,
          (data as { agentRunId: number }).agentRunId,
          'waiting_plan',
        );
        return;
      }
      if (eventType === 'subordinate_question_posted') {
        streamApplySubordinateWaiting(
          companySessionId,
          (data as { agentRunId: number }).agentRunId,
          'waiting_question',
        );
        return;
      }
      if (eventType === 'subordinate_tasks_posted') {
        streamApplySubordinateWaiting(
          companySessionId,
          (data as { agentRunId: number }).agentRunId,
          'waiting_tasks',
        );
        return;
      }
      if (eventType === 'agent_status') {
        streamApplyAgentStatus(companySessionId, data as AgentStatusPayload);
        return;
      }
      if (
        eventType === 'master_plan_posted' ||
        eventType === 'master_question_posted' ||
        eventType === 'master_plan_resolved' ||
        eventType === 'master_question_resolved' ||
        eventType === 'master_prompt_cancelled'
      ) {
        const d = data as { prompt?: MasterPrompt };
        if (d.prompt) streamApplyMasterPrompt(companySessionId, d.prompt);
        return;
      }
      if (eventType.startsWith('kanban_')) {
        kanbanApplyEvent(companySessionId, eventType, data);
        return;
      }
      if (eventType === 'session_idle') {
        streamApplySessionIdle(companySessionId, data as SessionIdlePayload);
        return;
      }
      if (eventType === 'error') {
        receivedDoneRef.current = true;
        streamSetConnected(companySessionId, false);
        streamSetError(
          companySessionId,
          (data as { error?: string }).error ?? 'Unknown error from server',
        );
        return;
      }
      if (eventType === 'sandbox.file_changed') {
        const payload = (data ?? {}) as {
          path?: string;
          serviceId?: string;
          changeType?: string;
        };
        sandboxApplyFileChange(companySessionId, {
          path: payload.path ?? '',
          serviceId: payload.serviceId,
          changeType: payload.changeType,
        });
        return;
      }
      if (eventType === 'drive.file_added' || eventType === 'drive.file_updated') {
        const payload = data as { meta?: DriveFileMeta } | null;
        if (payload?.meta) {
          if (eventType === 'drive.file_added') {
            driveApplyAdded(companySessionId, payload.meta);
          } else {
            driveApplyUpdated(companySessionId, payload.meta);
          }
        }
        return;
      }
      if (eventType === 'drive.file_deleted') {
        const payload = (data ?? {}) as { path?: string };
        if (payload.path) driveApplyDeleted(companySessionId, payload.path);
        return;
      }
      if (
        eventType === 'inbox_message_sent' ||
        eventType === 'inbox_message_delivered' ||
        eventType === 'inbox_message_answered' ||
        eventType === 'inbox_message_cancelled' ||
        eventType === 'inbox_message_expired'
      ) {
        // Payloads are thin (id + routing). Bump the seq counter and let
        // the panel refetch through REST. Phase 4 will widen the payloads
        // so the slice can update incrementally without round-trips.
        inboxBumpEventSeq(companySessionId);
        return;
      }
      if (eventType === 'done') {
        receivedDoneRef.current = true;
        streamSetConnected(companySessionId, false);
      }
    },
    [
      companySessionId,
      streamApplyAgentEvent,
      streamApplyAgentStatus,
      streamApplySubordinateWaiting,
      streamApplyBoardEntry,
      streamApplyMasterPrompt,
      streamApplySessionIdle,
      streamSetConnected,
      streamSetError,
      kanbanApplyEvent,
      sandboxApplyFileChange,
      driveApplyAdded,
      driveApplyUpdated,
      driveApplyDeleted,
      inboxBumpEventSeq,
    ],
  );

  const onSSEEvent = useCallback(
    (ev: SSEEvent) => {
      if (ev.id !== undefined && ev.id > lastSeenSeqRef.current) {
        lastSeenSeqRef.current = ev.id;
      }
      let parsed: unknown = null;
      if (ev.data) {
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          parsed = null;
        }
      }
      handleSSEEvent(ev.event, parsed);
    },
    [handleSSEEvent],
  );

  // ─── Data loaders ────────────────────────────────────────────

  const loadKanbanFromDB = useCallback(async () => {
    if (companySessionId == null) return;
    try {
      const res = await fetch(`/api/company/sessions/${companySessionId}/kanban?full=true`);
      if (!res.ok) return;
      const cards = await res.json();
      if (Array.isArray(cards)) kanbanHydrate(companySessionId, cards);
    } catch {
      /* best-effort */
    }
  }, [companySessionId, kanbanHydrate]);

  const loadFinalStateFromDB = useCallback(async () => {
    if (companySessionId == null) return;
    try {
      const res = await fetch(`/api/company/sessions/${companySessionId}`);
      if (!res.ok) return;
      const data = (await res.json()) as InitialFetchResponse;
      const boardMessages: BoardMessage[] = (data.recentBoard ?? []).map((b) => ({
        id: b.id,
        author_role: b.author_role,
        agent_run_id: b.agent_run_id,
        kind: b.kind,
        content: b.content,
        mentions: JSON.parse(b.mentions_json || '[]'),
        created_at: b.created_at,
      }));
      const subs = new Map<number, AgentStreamState>();
      let master: AgentStreamState | null = null;
      for (const run of data.agentRuns ?? []) {
        const agentState: AgentStreamState = {
          role: run.role,
          agentRunId: run.id,
          coderSessionId: run.coder_session_id,
          textChunks: [],
          toolCalls: [],
          status: run.status,
          statusMessage: run.status_message,
        };
        if (run.role === 'master') master = agentState;
        else subs.set(run.id, agentState);
      }
      streamHydrateFromInitialFetch(companySessionId, {
        boardMessages,
        masterState: master,
        subordinateStates: subs,
        masterPrompts: data.masterPrompts ?? [],
      });
    } catch {
      /* ignore */
    }
    await loadKanbanFromDB();
  }, [companySessionId, streamHydrateFromInitialFetch, loadKanbanFromDB]);

  // ─── Stream open helper ──────────────────────────────────────

  const openStream = useCallback(
    async (opts: {
      url: string;
      method: 'GET' | 'POST';
      body?: unknown;
      onReconnect?: (attempt: number) => void | Promise<void>;
      suppressError?: (err: Error) => boolean;
    }): Promise<void> => {
      if (companySessionId == null) return;
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
        streamSetError(companySessionId, `Connection error: ${(e as Error).message}`);
      } finally {
        streamSetConnected(companySessionId, false);
      }
    },
    [companySessionId, onSSEEvent, loadKanbanFromDB, streamSetConnected, streamSetError],
  );

  // ─── Public actions ──────────────────────────────────────────

  const start = useCallback(
    async (userMessage: string, attachments?: AgentAttachment[], opts?: { thinking?: boolean }) => {
      if (companySessionId == null) return;
      lastSeenSeqRef.current = -1;
      streamReset(companySessionId);
      streamSetStarted(companySessionId, true);
      streamSetConnected(companySessionId, true);
      streamSetUserMessage(companySessionId, userMessage);
      await openStream({
        url: `/api/company/sessions/${companySessionId}/start`,
        method: 'POST',
        body: {
          user_message: userMessage,
          attachments: attachments?.length ? attachments : undefined,
          thinking: opts?.thinking || undefined,
        },
      });
    },
    [companySessionId, openStream, streamReset, streamSetStarted, streamSetConnected, streamSetUserMessage],
  );

  const resume = useCallback(
    async (message: string, attachments?: AgentAttachment[], opts?: { thinking?: boolean }) => {
      if (companySessionId == null) return;
      streamSetStarted(companySessionId, true);
      streamSetConnected(companySessionId, true);
      streamSetError(companySessionId, null);
      await openStream({
        url: `/api/company/sessions/${companySessionId}/resume`,
        method: 'POST',
        body: {
          message,
          attachments: attachments?.length ? attachments : undefined,
          thinking: opts?.thinking || undefined,
        },
      });
    },
    [companySessionId, openStream, streamSetStarted, streamSetConnected, streamSetError],
  );

  const reattach = useCallback(async () => {
    if (companySessionId == null) return;
    streamSetStarted(companySessionId, true);
    streamSetConnected(companySessionId, true);
    streamSetError(companySessionId, null);
    await loadKanbanFromDB();
    try {
      await openStream({
        url: `/api/company/sessions/${companySessionId}/attach`,
        method: 'GET',
        suppressError: (e) => e.message === 'HTTP 404',
      });
    } finally {
      await loadFinalStateFromDB();
    }
  }, [
    companySessionId,
    openStream,
    streamSetStarted,
    streamSetConnected,
    streamSetError,
    loadKanbanFromDB,
    loadFinalStateFromDB,
  ]);

  const abort = useCallback(async () => {
    if (companySessionId == null) return;
    abortRef.current?.abort();
    try {
      await fetch(`/api/company/sessions/${companySessionId}/abort`, { method: 'POST' });
    } catch {
      /* ignore */
    }
    streamSetConnected(companySessionId, false);
  }, [companySessionId, streamSetConnected]);

  const sendMessage = useCallback(
    async (message: string, attachments?: AgentAttachment[], opts?: { thinking?: boolean }) => {
      if (companySessionId == null) return;
      try {
        const res = await fetch(`/api/company/sessions/${companySessionId}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            attachments: attachments?.length ? attachments : undefined,
            thinking: opts?.thinking || undefined,
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const errorMsg = res.status === 404
            ? 'Session is no longer active. Start a new session or reload the page.'
            : `Failed to send message (${res.status}): ${body}`;
          streamSetError(companySessionId, errorMsg);
        }
      } catch (e) {
        console.error('Failed to send message to master:', e);
        streamSetError(companySessionId, `Connection error: ${(e as Error).message}`);
      }
    },
    [companySessionId, streamSetError],
  );

  const respondToMasterPlan = useCallback(
    async (promptId: number, approved: boolean, feedback?: string) => {
      if (companySessionId == null) return;
      try {
        const res = await fetch(`/api/company/sessions/${companySessionId}/plan-response`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved, feedback, prompt_id: promptId }),
        });
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { prompt?: MasterPrompt } | null;
          if (body?.prompt) streamApplyMasterPrompt(companySessionId, body.prompt);
        } else if (res.status !== 409) {
          const body = await res.text().catch(() => '');
          streamSetError(companySessionId, `Failed to respond to plan (${res.status}): ${body}`);
        }
      } catch (e) {
        console.error('Failed to respond to master plan:', e);
      }
    },
    [companySessionId, streamApplyMasterPrompt, streamSetError],
  );

  const respondToMasterQuestion = useCallback(
    async (promptId: number, answer: string) => {
      if (companySessionId == null) return;
      try {
        const res = await fetch(`/api/company/sessions/${companySessionId}/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer, prompt_id: promptId }),
        });
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { prompt?: MasterPrompt } | null;
          if (body?.prompt) streamApplyMasterPrompt(companySessionId, body.prompt);
        } else if (res.status !== 409) {
          const body = await res.text().catch(() => '');
          const errorMsg = res.status === 404
            ? 'Session is no longer active. Your answer could not be delivered.'
            : `Failed to answer (${res.status}): ${body}`;
          streamSetError(companySessionId, errorMsg);
        }
      } catch (e) {
        console.error('Failed to answer master question:', e);
        streamSetError(companySessionId, `Connection error: ${(e as Error).message}`);
      }
    },
    [companySessionId, streamApplyMasterPrompt, streamSetError],
  );

  const switchProvider = useCallback(
    async (
      provider: string,
      model?: string,
      roleAssignments?: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[] }>,
    ) => {
      if (companySessionId == null) return;
      try {
        const res = await fetch(`/api/company/sessions/${companySessionId}/switch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, model, role_assignments: roleAssignments }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          streamSetError(companySessionId, `Switch failed: ${body}`);
        }
      } catch (e) {
        streamSetError(companySessionId, `Switch error: ${(e as Error).message}`);
      }
    },
    [companySessionId, streamSetError],
  );

  const hydrateMasterPrompts = useCallback(
    (prompts: MasterPrompt[]) => {
      if (companySessionId == null) return;
      streamHydrateMasterPromptsAction(companySessionId, prompts);
    },
    [companySessionId, streamHydrateMasterPromptsAction],
  );

  const reset = useCallback(() => {
    if (companySessionId == null) return;
    abortRef.current?.abort();
    lastSeenSeqRef.current = -1;
    receivedDoneRef.current = false;
    streamReset(companySessionId);
  }, [companySessionId, streamReset]);

  return {
    connected: stream.connected,
    started: stream.started,
    masterState: stream.masterState,
    subordinateStates: stream.subordinateStates,
    boardMessages: stream.boardMessages,
    masterPrompts: stream.masterPrompts,
    fallbackNotices: stream.fallbackNotices,
    error: stream.error,
    userMessage: stream.userMessage,
    masterErrorDetail: stream.masterErrorDetail,
    start,
    resume,
    reattach,
    abort,
    reset,
    sendMessage,
    switchProvider,
    respondToMasterPlan,
    respondToMasterQuestion,
    hydrateMasterPrompts,
  };
}

// ─── Internal helpers ─────────────────────────────────────────

interface InitialFetchResponse {
  recentBoard?: Array<{
    id: number;
    author_role: string;
    agent_run_id: number | null;
    kind: string;
    content: string;
    mentions_json: string;
    created_at: string;
  }>;
  agentRuns?: Array<{
    id: number;
    role: string;
    coder_session_id: number;
    status: AgentStreamState['status'];
    status_message: string;
  }>;
  masterPrompts?: MasterPrompt[];
}
