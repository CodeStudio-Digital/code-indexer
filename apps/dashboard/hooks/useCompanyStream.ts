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
import { useCallback, useRef, useState } from 'react';
import { ReconnectingSSEClient } from '@mcp/shared/sse/ReconnectingSSEClient.js';
import type { SSEEvent } from '@mcp/shared/sse/SSEFramer.js';
import type { MasterPrompt } from '@mcp/company-contracts';
import { apiBaseUrl } from '../lib/api-client.js';

import type { AgentAttachment } from './agent-stream/types.js';
import { useAgentControls } from './useAgentControls.js';
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
import { mapAutonomyStreamEvent } from '../state/company/stream-handlers/autonomyEvent.js';
import { notifyCompanyStreamEvent, type NotificationSourceContext } from '../features/notifications/index.js';

// Re-export client state types so legacy consumers keep their imports.
export type { AgentStreamState, BoardMessage, FallbackNotice } from '../state/company/types.js';

export function useCompanyStream(companySessionId: number | null, notificationContext?: NotificationSourceContext) {
  // ─── Selectors ───────────────────────────────────────────────
  const stream = useCompanyStore((s) => selectStream(s, companySessionId));
  const notificationContextRef = useRef(notificationContext);
  notificationContextRef.current = notificationContext;

  // Snapshot of liveness + pending master inbox count. Refreshed on
  // every `reattach()` call from /state-snapshot. The dashboard's
  // phase indicator + "Acordar Master" button read from here so the
  // UI can tell apart "starting" vs "standby" vs "pending — wake me".
  const [masterLiveness, setMasterLiveness] = useState<{
    masterAlive: boolean;
    pendingMasterInboxCount: number;
    liveOrchestrator: boolean;
  }>({ masterAlive: true, pendingMasterInboxCount: 0, liveOrchestrator: true });

  // ─── Action dispatchers (stable refs from zustand) ───────────
  const streamReset = useCompanyStore((s) => s.streamReset);
  const streamSetStarted = useCompanyStore((s) => s.streamSetStarted);
  const streamSetConnected = useCompanyStore((s) => s.streamSetConnected);
  const streamSetError = useCompanyStore((s) => s.streamSetError);
  const streamSetUserMessage = useCompanyStore((s) => s.streamSetUserMessage);
  const streamApplyAgentEvent = useCompanyStore((s) => s.streamApplyAgentEvent);
  const streamApplyAgentStatus = useCompanyStore((s) => s.streamApplyAgentStatus);
  const streamApplySubordinateWaiting = useCompanyStore((s) => s.streamApplySubordinateWaiting);
  const streamRemoveSubordinate = useCompanyStore((s) => s.streamRemoveSubordinate);
  const streamApplyBoardEntry = useCompanyStore((s) => s.streamApplyBoardEntry);
  const streamApplyMasterPrompt = useCompanyStore((s) => s.streamApplyMasterPrompt);
  const streamApplySessionIdle = useCompanyStore((s) => s.streamApplySessionIdle);
  const streamApplySessionStalled = useCompanyStore((s) => s.streamApplySessionStalled);
  const streamSetConnectionPhase = useCompanyStore((s) => s.streamSetConnectionPhase);
  const streamHydrateMasterPromptsAction = useCompanyStore((s) => s.streamHydrateMasterPrompts);
  const streamHydrateFromInitialFetch = useCompanyStore((s) => s.streamHydrateFromInitialFetch);
  const kanbanApplyEvent = useCompanyStore((s) => s.kanbanApplyEvent);
  const kanbanHydrate = useCompanyStore((s) => s.kanbanHydrate);
  const sandboxApplyFileChange = useCompanyStore((s) => s.sandboxApplyFileChange);
  const sandboxBumpStatus = useCompanyStore((s) => s.sandboxBumpStatus);
  const sandboxBumpServices = useCompanyStore((s) => s.sandboxBumpServices);
  const sandboxAppendServiceLogs = useCompanyStore((s) => s.sandboxAppendServiceLogs);
  const sandboxApplyServiceHealth = useCompanyStore((s) => s.sandboxApplyServiceHealth);
  const driveApplyAdded = useCompanyStore((s) => s.driveApplyAdded);
  const driveApplyUpdated = useCompanyStore((s) => s.driveApplyUpdated);
  const driveApplyDeleted = useCompanyStore((s) => s.driveApplyDeleted);
  const inboxBumpEventSeq = useCompanyStore((s) => s.inboxBumpEventSeq);
  const autonomyPushEvent = useCompanyStore((s) => s.autonomyPushEvent);

  // ─── Transport refs ──────────────────────────────────────────
  const abortRef = useRef<AbortController | null>(null);
  const lastSeenSeqRef = useRef<number>(-1);
  const receivedDoneRef = useRef<boolean>(false);

  // ─── SSE event dispatch ──────────────────────────────────────

  const handleSSEEvent = useCallback(
    (eventType: string, data: unknown) => {
      if (companySessionId == null) return;
      notifyCompanyStreamEvent(
        companySessionId,
        eventType,
        data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined,
        notificationContextRef.current,
      );

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
      if (eventType === 'session_stalled') {
        const d = (data ?? {}) as { stalledSinceMs?: number };
        streamApplySessionStalled(
          companySessionId,
          typeof d.stalledSinceMs === 'number' ? d.stalledSinceMs : 0,
        );
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
      // P14b — sandbox lifecycle events kill the legacy 1.5–10 s
      // poller in `useSandboxStatus`. `SandboxService.forwardEvent`
      // republishes every non-`stats`/`log`/`step` sandbox transition
      // under these names; the slice bumps `statusSeq` and the hook
      // refetches `/sandbox` once per event. We also bump
      // `servicesSeq` because the primary sandbox is a row in
      // `/services`, so a status change there is a services-list
      // mutation too.
      if (
        eventType === 'sandbox.ready' ||
        eventType === 'sandbox.paused' ||
        eventType === 'sandbox.resumed' ||
        eventType === 'sandbox.error' ||
        eventType === 'sandbox.destroying' ||
        eventType === 'sandbox.destroyed' ||
        eventType === 'sandbox.provisioning'
      ) {
        sandboxBumpStatus(companySessionId);
        sandboxBumpServices(companySessionId);
        return;
      }
      // B6 — live structured log tail from the supervisor's collector.
      // Appended to the bounded per-service buffer (500 lines); history
      // pagination goes through REST (`/logs/history`).
      if (eventType === 'sandbox.service.log_batch') {
        const p = (data ?? {}) as {
          serviceId?: string;
          lines?: Array<{ atMs?: number; stream?: string; line?: string }>;
        };
        if (typeof p.serviceId === 'string' && p.serviceId && Array.isArray(p.lines)) {
          sandboxAppendServiceLogs(companySessionId, p.serviceId, p.lines);
        }
        return;
      }
      // B8 — supervisor verdicts also land in the per-service health map:
      // host-process rows (`local:<id>`) have no persisted health column,
      // so the refetch below would keep them 'unknown' forever — the map
      // is their live source (overlaid by the services sidebar).
      if (eventType === 'sandbox.service.health') {
        const p = (data ?? {}) as {
          serviceId?: string;
          health?: string;
          detail?: string | null;
          at?: number;
        };
        if (typeof p.serviceId === 'string' && p.serviceId && typeof p.health === 'string') {
          sandboxApplyServiceHealth(
            companySessionId,
            p.serviceId,
            p.health,
            p.detail ?? null,
            typeof p.at === 'number' ? p.at : Date.now(),
          );
        }
        sandboxBumpServices(companySessionId);
        return;
      }
      // Service-list mutations (add/remove + synthetic status_changed
      // emitted on every primary-sandbox transition by forwardEvent).
      // B6 adds the supervisor verdict events so health badges refresh:
      // `.restarted`/`.incident` are rare, so the extra refetches stay cheap.
      if (
        eventType === 'sandbox.service.added' ||
        eventType === 'sandbox.service.removed' ||
        eventType === 'sandbox.service.status_changed' ||
        eventType === 'sandbox.service.restarted' ||
        eventType === 'sandbox.service.incident'
      ) {
        sandboxBumpServices(companySessionId);
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
      // C1 — organism visibility: scheduler dispatch/skip/sweep, plan
      // auto-approvals, supervisor incidents and master nudges feed the
      // autonomy ring (AutonomyPanel / AutonomyActivityFeed / banner).
      const autonomyEvent = mapAutonomyStreamEvent(eventType, data);
      if (autonomyEvent) {
        autonomyPushEvent(companySessionId, autonomyEvent);
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
      streamApplySessionStalled,
      streamSetConnectionPhase,
      streamSetConnected,
      streamSetError,
      kanbanApplyEvent,
      sandboxApplyFileChange,
      sandboxBumpStatus,
      sandboxBumpServices,
      sandboxAppendServiceLogs,
      sandboxApplyServiceHealth,
      driveApplyAdded,
      driveApplyUpdated,
      driveApplyDeleted,
      inboxBumpEventSeq,
      autonomyPushEvent,
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
      const res = await fetch(`${apiBaseUrl()}/api/company/sessions/${companySessionId}/kanban?full=true`);
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
      const res = await fetch(`${apiBaseUrl()}/api/company/sessions/${companySessionId}`);
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
      body?: Record<string, unknown>;
      onReconnect?: (attempt: number) => void | Promise<void>;
      suppressError?: (err: Error) => boolean;
    }): Promise<void> => {
      if (companySessionId == null) return;
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      receivedDoneRef.current = false;

      // Stamp a stable idempotency key on POST bodies (same object reused
      // across ReconnectingSSEClient retries → stable key). The server dedupes
      // a re-POST of /start or /resume into a metaBus replay instead of a
      // spurious "Already running" 409 or a duplicate message to the master.
      if (opts.method === 'POST') {
        const b = (opts.body ??= {});
        if (typeof b.client_msg_id !== 'string') {
          b.client_msg_id =
            globalThis.crypto?.randomUUID?.() ??
            `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        }
      }

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
        onPhase: (phase) => streamSetConnectionPhase(companySessionId, phase),
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
        url: `${apiBaseUrl()}/api/company/sessions/${companySessionId}/start`,
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
        url: `${apiBaseUrl()}/api/company/sessions/${companySessionId}/resume`,
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
    // First decide whether there's actually an alive master to attach
    // to. The new /state-snapshot endpoint always returns 200 (when the
    // session exists) with `liveOrchestrator` + `masterAlive` flags +
    // the same payload `/sessions/:id` returns. This pre-flight kills
    // the "Iniciando Master..." deadlock: if the master already ended,
    // /attach 200 would still hang the UI waiting for events that will
    // never come, because the SSE replay carries only past `session_idle`
    // (which used to be a no-op when masterState was null).
    streamSetError(companySessionId, null);
    await loadKanbanFromDB();
    let snapshot: {
      liveOrchestrator?: boolean;
      masterAlive?: boolean;
      pendingMasterInboxCount?: number;
    } | null = null;
    try {
      const r = await fetch(`${apiBaseUrl()}/api/company/sessions/${companySessionId}/state-snapshot`);
      if (r.ok) snapshot = (await r.json()) as typeof snapshot;
    } catch {
      /* fall through to /attach optimistic path */
    }
    // Latch the liveness flags so the UI can read them while deciding
    // whether to show a spinner, the standby badge, or the wake CTA.
    if (snapshot) {
      setMasterLiveness({
        masterAlive: !!snapshot.masterAlive,
        liveOrchestrator: !!snapshot.liveOrchestrator,
        pendingMasterInboxCount: snapshot.pendingMasterInboxCount ?? 0,
      });
    }
    // No orchestrator OR master finished: hydrate from DB and stop.
    // The UI renders the master-idle/standby pill via the phase
    // indicator selector — never the loader.
    if (snapshot && (!snapshot.liveOrchestrator || !snapshot.masterAlive)) {
      streamSetStarted(companySessionId, false);
      streamSetConnected(companySessionId, false);
      await loadFinalStateFromDB();
      return;
    }
    // Otherwise master is alive: keep the optimistic loader until the
    // first agent_status event arrives via SSE. The /attach 404 fallback
    // below also remains as a belt-and-suspenders for the rare race
    // where the orchestrator dies between snapshot and attach.
    streamSetStarted(companySessionId, true);
    streamSetConnected(companySessionId, true);
    let attached = false;
    try {
      await openStream({
        url: `${apiBaseUrl()}/api/company/sessions/${companySessionId}/attach`,
        method: 'GET',
        suppressError: (e) => {
          if (e.message === 'HTTP 404') {
            streamSetStarted(companySessionId, false);
            streamSetConnected(companySessionId, false);
            return true;
          }
          return false;
        },
      });
      attached = true;
    } finally {
      if (attached) await loadFinalStateFromDB();
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
      await fetch(`${apiBaseUrl()}/api/company/sessions/${companySessionId}/abort`, { method: 'POST' });
    } catch {
      /* ignore */
    }
    streamSetConnected(companySessionId, false);
  }, [companySessionId, streamSetConnected]);

  const sendMessage = useCallback(
    async (
      message: string,
      attachments?: AgentAttachment[],
      opts?: { thinking?: boolean; interject?: boolean },
    ) => {
      if (companySessionId == null) return;
      try {
        const res = await fetch(`${apiBaseUrl()}/api/company/sessions/${companySessionId}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            attachments: attachments?.length ? attachments : undefined,
            thinking: opts?.thinking || undefined,
            // `interject: true` instructs the orchestrator to break any
            // interactive wait (ask_user / submit_plan / etc) before
            // queuing the message. Used by the SessionStalledBanner so
            // the "Continue" button actually unblocks the master instead
            // of just appending another row to pendingUserMessages while
            // the runner sits hung.
            interject: opts?.interject || undefined,
          }),
        });
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { resumed?: boolean } | null;
          // Backend re-spawned + resumed an evicted/restarted master — re-attach
          // the SSE so the master's continuation streams instead of going silent.
          if (body?.resumed) { streamSetStarted(companySessionId, true); void reattach(); }
        } else {
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
    [companySessionId, streamSetError, streamSetStarted, reattach],
  );

  const respondToMasterPlan = useCallback(
    async (promptId: number, approved: boolean, feedback?: string) => {
      if (companySessionId == null) return;
      try {
        const res = await fetch(`${apiBaseUrl()}/api/company/sessions/${companySessionId}/plan-response`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved, feedback, prompt_id: promptId }),
        });
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { prompt?: MasterPrompt; resumed?: boolean } | null;
          if (body?.prompt) streamApplyMasterPrompt(companySessionId, body.prompt);
          if (body?.resumed) { streamSetStarted(companySessionId, true); void reattach(); }
        } else if (res.status !== 409) {
          const body = await res.text().catch(() => '');
          streamSetError(companySessionId, `Failed to respond to plan (${res.status}): ${body}`);
        }
      } catch (e) {
        console.error('Failed to respond to master plan:', e);
      }
    },
    [companySessionId, streamApplyMasterPrompt, streamSetError, streamSetStarted, reattach],
  );

  const respondToMasterQuestion = useCallback(
    async (promptId: number, answer: string) => {
      if (companySessionId == null) return;
      try {
        const res = await fetch(`${apiBaseUrl()}/api/company/sessions/${companySessionId}/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer, prompt_id: promptId }),
        });
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { prompt?: MasterPrompt; resumed?: boolean } | null;
          if (body?.prompt) streamApplyMasterPrompt(companySessionId, body.prompt);
          // The orchestrator had been evicted/restarted; the backend re-spawned
          // and resumed the master. Re-establish the SSE so the continuation streams.
          if (body?.resumed) { streamSetStarted(companySessionId, true); void reattach(); }
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
    [companySessionId, streamApplyMasterPrompt, streamSetError, streamSetStarted, reattach],
  );

  const switchProvider = useCallback(
    async (
      provider: string,
      model?: string,
      roleAssignments?: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[] }>,
    ) => {
      if (companySessionId == null) return;
      try {
        const res = await fetch(`${apiBaseUrl()}/api/company/sessions/${companySessionId}/switch`, {
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

  /**
   * Manual "Acordar Master" trigger. POSTs the wake-master endpoint
   * which forwards to the inbox router's idempotent delivery path.
   * Updates local liveness on success so the badge/button flips
   * immediately without waiting for the next reattach.
   */
  const wakeMaster = useCallback(async (): Promise<
    { revived: boolean; reason?: string } | null
  > => {
    if (companySessionId == null) return null;
    try {
      const r = await fetch(`${apiBaseUrl()}/api/company/sessions/${companySessionId}/wake-master`, {
        method: 'POST',
      });
      if (!r.ok) return null;
      const body = (await r.json()) as { revived: boolean; reason?: string };
      if (body.revived) {
        // Optimistically clear pending so the badge disappears while
        // the master spins up. The next reattach / SSE update will
        // reconcile if delivery surfaced more messages mid-flight.
        setMasterLiveness((prev) => ({
          ...prev,
          masterAlive: true,
          pendingMasterInboxCount: 0,
        }));
      }
      return body;
    } catch {
      return null;
    }
  }, [companySessionId]);

  // Per-agent (subordinate) control — pause / resume / delete. Lives in a
  // dedicated hook to keep this file from growing further.
  const { pauseAgent, resumeAgent, deleteAgent } = useAgentControls(
    companySessionId,
    streamSetError,
    streamRemoveSubordinate,
  );

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
    masterEndedAt: stream.masterEndedAt,
    masterEndedUnexpected: stream.masterEndedUnexpected,
    sessionStalledSinceMs: stream.sessionStalledSinceMs,
    connectionPhase: stream.connectionPhase,
    // Item 8: phase-indicator-friendly liveness flags. Fetched on
    // reattach + updated optimistically by `wakeMaster`. Default values
    // (`alive=true`, `pending=0`) keep first render quiet — the
    // snapshot fetch flips them when relevant.
    masterAlive: masterLiveness.masterAlive,
    pendingMasterInboxCount: masterLiveness.pendingMasterInboxCount,
    liveOrchestrator: masterLiveness.liveOrchestrator,
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
    wakeMaster,
    pauseAgent,
    resumeAgent,
    deleteAgent,
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
