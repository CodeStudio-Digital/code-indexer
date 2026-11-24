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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ReconnectingSSEClient } from '@mcp/shared/sse/ReconnectingSSEClient.js';
import type { SSEEvent } from '@mcp/shared/sse/SSEFramer.js';
import type { MasterPrompt } from '@mcp/company-contracts';
import { apiBaseUrl } from '../lib/api-client.js';
import { companyStreamError } from './company-stream-error.js';
import { submitMasterReply, type MasterReply } from './company-prompt-response.js';

import type { AgentAttachment } from './agent-stream/types.js';
import { useAgentControls } from './useAgentControls.js';
import { onCompanyPanelChange } from '../lib/company-panel-changes.js';
import { useCompanyStore, selectStreamSummary } from '../state/company/index.js';
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
import type { NotificationSourceContext } from '../features/notifications/index.js';

// Re-export client state types so legacy consumers keep their imports.
export type { AgentStreamState, BoardMessage } from '../state/company/types.js';

interface CompanyStreamTransport {
  basePath: string;
  statePath: string;
  includeKanban: boolean;
  allowDirectAgentControls: boolean;
  allowRuntimeSwitch: boolean;
  /** Whether transport remains attached while the orchestrator is live. */
  keepAttachedWhileOrchestratorLive: boolean;
}

interface CompanyStreamCursor {
  seq: number;
  busId: string | null;
}

/** Pure cursor reducer used by SSE today and reusable by explicit WS consumers. */
export function advanceCompanyStreamCursor(
  current: CompanyStreamCursor,
  event: SSEEvent,
  parsedData: unknown,
): CompanyStreamCursor {
  if (event.event === 'bus_info') {
    const busId = parsedData && typeof parsedData === 'object'
      && typeof (parsedData as { bus_id?: unknown }).bus_id === 'string'
      ? (parsedData as { bus_id: string }).bus_id
      : null;
    if (!busId) return current;
    return {
      busId,
      seq: busId === current.busId ? current.seq : -1,
    };
  }
  return typeof event.id === 'number' && event.id > current.seq
    ? { ...current, seq: event.id }
    : current;
}

interface MutableCurrent<T> { current: T }

/** Fence all asynchronous work belonging to one intent, including preflight
 * fetches and final hydration. A replacement within the same React mount is
 * just as obsolete as an unmounted lifecycle. */
export function beginCompanyStreamRequest(
  lifecycle: MutableCurrent<number>,
  requests: MutableCurrent<number>,
  controller: MutableCurrent<AbortController | null>,
  mounted?: MutableCurrent<boolean>,
): () => boolean {
  const generation = lifecycle.current;
  const request = ++requests.current;
  controller.current?.abort();
  controller.current = null;
  return () => mounted?.current !== false && lifecycle.current === generation && requests.current === request;
}

export function unconfirmedCompanyLiveness(current: { pendingMasterInboxCount: number }) {
  return { masterAlive: false, liveOrchestrator: false, pendingMasterInboxCount: current.pendingMasterInboxCount };
}

const COMPANY_EVENT_BATCH_SIZE = 50;

function yieldCompanyStreamTurn(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

export function isCompanyStreamOwner(
  lifecycleGenerationRef: MutableCurrent<number>,
  abortRef: MutableCurrent<AbortController | null>,
  generation: number,
  controller: AbortController,
): boolean {
  return lifecycleGenerationRef.current === generation
    && abortRef.current === controller
    && !controller.signal.aborted;
}

interface CompanyStreamEventPump {
  enqueue(event: SSEEvent): void;
  flush(): Promise<void>;
  discard(): void;
}

/**
 * Ordered, yielding event pump for replay bursts.
 *
 * The cursor is advanced by the supplied processor, after its state mutation
 * succeeds. A superseded/aborted owner drops its queue, so late frames from an
 * older fetch cannot mutate the replacement stream.
 */
export function createCompanyStreamEventPump(opts: {
  isActive: () => boolean;
  processEvent: (event: SSEEvent) => void;
  yieldTurn?: () => Promise<void>;
  batchSize?: number;
}): CompanyStreamEventPump {
  const queue: SSEEvent[] = [];
  const yieldTurn = opts.yieldTurn ?? yieldCompanyStreamTurn;
  const batchSize = Math.max(1, opts.batchSize ?? COMPANY_EVENT_BATCH_SIZE);
  let draining = false;
  let drainDone: Promise<void> = Promise.resolve();

  const drain = async (): Promise<void> => {
    draining = true;
    try {
      do {
        await yieldTurn();
        if (!opts.isActive()) {
          queue.length = 0;
          return;
        }
        const batch = queue.splice(0, batchSize);
        for (const event of batch) {
          if (!opts.isActive()) {
            queue.length = 0;
            return;
          }
          opts.processEvent(event);
        }
      } while (queue.length > 0);
    } finally {
      draining = false;
    }
  };

  return {
    enqueue(event) {
      if (!opts.isActive()) return;
      queue.push(event);
      if (!draining) drainDone = drain();
    },
    async flush() {
      await drainDone;
    },
    discard() {
      queue.length = 0;
    },
  };
}

/** Shared teardown primitive for unmount and session rotation. */
export function disposeCompanyStreamLifecycle(
  lifecycleGenerationRef: MutableCurrent<number>,
  abortRef: MutableCurrent<AbortController | null>,
  generation: number,
): void {
  if (lifecycleGenerationRef.current !== generation) return;
  lifecycleGenerationRef.current += 1;
  abortRef.current?.abort();
  abortRef.current = null;
}

/** Pure transport resolver for Company sessions. */
export function resolveCompanyStreamTransport(
  companySessionId: string | null,
): CompanyStreamTransport | null {
  if (companySessionId == null) return null;
  return {
    basePath: `/api/company/sessions/${companySessionId}`,
    statePath: '',
    includeKanban: true,
    allowDirectAgentControls: true,
    allowRuntimeSwitch: true,
    keepAttachedWhileOrchestratorLive: true,
  };
}

function invalidatesTeamOverview(eventType: string, data: unknown): boolean {
  if (
    eventType === 'agent_status'
    || eventType === 'session.config_updated'
    || eventType === 'session_idle'
    || eventType === 'done'
    || eventType === 'error'
    || eventType.startsWith('subordinate_')
    || eventType.startsWith('master_')
    || eventType.startsWith('inbox_')
    || eventType.startsWith('app_')
  ) return true;
  if (eventType !== 'agent_event') return false;
  const nested = (data as { event?: unknown } | null)?.event;
  return nested === 'done' || nested === 'error' || nested === 'fallback_activated';
}

function isLiveMasterStatus(status: AgentStatusPayload['status']): boolean {
  return status !== 'idle'
    && status !== 'completed'
    && status !== 'error'
    && status !== 'aborted'
    && status !== 'interrupted';
}

export function useCompanyStream(
  companySessionId: string | null,
  _notificationContext?: NotificationSourceContext,
) {
  const transport = useMemo(() => resolveCompanyStreamTransport(companySessionId), [companySessionId]);
  const routeUrl = useCallback(
    (suffix = '') => transport ? `${apiBaseUrl()}${transport.basePath}${suffix}` : '',
    [transport],
  );
  // ─── Selectors ───────────────────────────────────────────────
  const stream = useCompanyStore(useShallow((s) => selectStreamSummary(s, companySessionId)));

  // Snapshot of liveness + pending master inbox count. Refreshed on
  // every `reattach()` call from /state-snapshot. The dashboard's
  // phase indicator + "Acordar Master" button read from here so the
  // UI can tell apart "starting" vs "standby" vs "pending — wake me".
  const [masterLiveness, setMasterLiveness] = useState<{
    masterAlive: boolean;
    pendingMasterInboxCount: number;
    liveOrchestrator: boolean;
  }>({ masterAlive: false, pendingMasterInboxCount: 0, liveOrchestrator: false });
  const [teamRevision, setTeamRevision] = useState(0);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const removedRuns = useMemo(() => new Set<string>(), [companySessionId]);

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
  const lifecycleGenerationRef = useRef(0);
  const requestGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const lastSeenSeqRef = useRef<number>(-1);
  const lastSeenBusIdRef = useRef<string | null>(null);
  const receivedDoneRef = useRef<boolean>(false);

  // A rail can be closed while reattach is still awaiting its snapshot. Abort
  // an already-open stream and invalidate the async continuation so it cannot
  // create a second, orphaned SSE client after unmount/session rotation.
  useEffect(() => {
    const generation = lifecycleGenerationRef.current + 1;
    lifecycleGenerationRef.current = generation;
    mountedRef.current = true;
    return () => {
      if (lifecycleGenerationRef.current === generation) mountedRef.current = false;
      disposeCompanyStreamLifecycle(lifecycleGenerationRef, abortRef, generation);
    };
  }, [companySessionId, transport?.basePath]);

  // ─── SSE event dispatch ──────────────────────────────────────

  const handleSSEEvent = useCallback(
    (eventType: string, data: unknown) => {
      if (companySessionId == null || !mountedRef.current) return;
      const runId = (data as { agentRunId?: string } | null)?.agentRunId;
      if (runId && removedRuns.has(runId)) return;
      if (invalidatesTeamOverview(eventType, data)) {
        setTeamRevision((revision) => revision + 1);
      }
      if (eventType === 'agent_event') {
        const nested = (data as AgentEventEnvelope).event;
        if (nested === 'tool_call_start' || nested === 'tool_call_result') setWorkspaceRevision(n => n + 1);
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
          (data as { agentRunId: string }).agentRunId,
          'waiting_plan',
        );
        return;
      }
      if (eventType === 'subordinate_question_posted') {
        streamApplySubordinateWaiting(
          companySessionId,
          (data as { agentRunId: string }).agentRunId,
          'waiting_question',
        );
        return;
      }
      if (eventType === 'subordinate_tasks_posted') {
        streamApplySubordinateWaiting(
          companySessionId,
          (data as { agentRunId: string }).agentRunId,
          'waiting_tasks',
        );
        return;
      }
      if (eventType === 'agent_status') {
        const status = data as AgentStatusPayload;
        if (status.role === 'master') {
          setMasterLiveness((current) => ({
            ...current,
            masterAlive: isLiveMasterStatus(status.status),
          }));
        }
        streamApplyAgentStatus(companySessionId, status);
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
        setMasterLiveness((current) => ({ ...current, masterAlive: false }));
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
      if (eventType === 'error' || eventType === 'master_boot_failed') {
        receivedDoneRef.current = true;
        const workerExited = (data as { reason?: string } | null)?.reason === 'worker_crashed';
        setMasterLiveness(current => workerExited ? unconfirmedCompanyLiveness(current) : { ...current, masterAlive: false });
        streamSetConnected(companySessionId, false);
        streamSetError(
          companySessionId,
          companyStreamError(data),
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
        setMasterLiveness((current) => ({ ...current, masterAlive: false }));
        streamSetConnected(companySessionId, false);
      }
    },
    [
      companySessionId,
      removedRuns,
      streamApplyAgentEvent,
      streamApplyAgentStatus,
      streamApplySubordinateWaiting,
      streamApplyBoardEntry,
      streamApplyMasterPrompt,
      streamApplySessionIdle,
      streamApplySessionStalled,
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
      let parsed: unknown = null;
      if (ev.data) {
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          parsed = null;
        }
      }
      if (ev.event !== 'bus_info') {
        handleSSEEvent(ev.event, parsed);
      }
      // Commit replay progress only after the handler has applied the event.
      // A reconnect can therefore never skip a frame that was merely parsed
      // or queued but not reflected in the store yet.
      const nextCursor = advanceCompanyStreamCursor({
        seq: lastSeenSeqRef.current,
        busId: lastSeenBusIdRef.current,
      }, ev, parsed);
      lastSeenSeqRef.current = nextCursor.seq;
      lastSeenBusIdRef.current = nextCursor.busId;
    },
    [handleSSEEvent],
  );

  // ─── Data loaders ────────────────────────────────────────────

  const loadKanbanFromDB = useCallback(async (isCurrent: () => boolean) => {
    if (companySessionId == null || !transport?.includeKanban || !isCurrent()) return;
    try {
      const res = await fetch(routeUrl('/kanban?full=true'));
      if (!res.ok) return;
      const cards = await res.json();
      if (isCurrent() && Array.isArray(cards)) kanbanHydrate(companySessionId, cards);
    } catch {
      /* best-effort */
    }
  }, [companySessionId, transport?.includeKanban, routeUrl, kanbanHydrate]);

  const loadFinalStateFromDB = useCallback(async (isCurrent: () => boolean) => {
    if (companySessionId == null || !isCurrent()) return;
    try {
      const res = await fetch(routeUrl(transport?.statePath ?? ''));
      if (!res.ok) return;
      const data = (await res.json()) as InitialFetchResponse;
      if (!isCurrent()) return;
      const boardMessages: BoardMessage[] = (data.recentBoard ?? []).map((b) => ({
        id: b.id,
        seq: b.seq,
        author_role: b.author_role,
        agent_run_id: b.agent_run_id,
        kind: b.kind,
        content: b.content,
        attachments: b.attachments,
        mentions: b.mentions,
        created_at: b.created_at,
      }));
      const subs = new Map<string, AgentStreamState>();
      let master: AgentStreamState | null = null;
      for (const run of data.agentRuns ?? []) {
        if (removedRuns.has(run.id)) continue;
        const agentState: AgentStreamState = {
          role: run.role,
          agentRunId: run.id,
          coderSessionId: run.coder_session_id,
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
    await loadKanbanFromDB(isCurrent);
  }, [companySessionId, transport, routeUrl, streamHydrateFromInitialFetch, loadKanbanFromDB, removedRuns]);

  // ─── Stream open helper ──────────────────────────────────────

  const openStream = useCallback(
    async (opts: {
      url: string;
      method: 'GET' | 'POST';
      body?: Record<string, unknown>;
      onReconnect?: (attempt: number) => void | Promise<void>;
      suppressError?: (err: Error) => boolean;
      isCurrent: () => boolean;
    }): Promise<'completed' | 'failed' | 'cancelled'> => {
      if (companySessionId == null || !opts.isCurrent()) return 'cancelled';
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const generation = lifecycleGenerationRef.current;
      const isActive = () => opts.isCurrent() && isCompanyStreamOwner(
        lifecycleGenerationRef,
        abortRef,
        generation,
        ctrl,
      );
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

      const eventPump = createCompanyStreamEventPump({
        isActive,
        processEvent: onSSEEvent,
      });
      const client = new ReconnectingSSEClient({
        url: opts.url,
        method: opts.method,
        body: opts.body,
        onEvent: (event) => eventPump.enqueue(event),
        getLastEventId: () => lastSeenSeqRef.current,
        getLastEventBusId: () => lastSeenBusIdRef.current,
        signal: ctrl.signal,
        onReconnect: async (attempt) => {
          // Do not request replay from a cursor whose event is still queued.
          await eventPump.flush();
          if (!isActive()) return;
          await loadKanbanFromDB(isActive);
          if (!isActive()) return;
          await opts.onReconnect?.(attempt);
        },
        onPhase: (phase) => {
          if (isActive()) {
            streamSetConnectionPhase(companySessionId, phase);
            streamSetConnected(companySessionId, phase === 'live' || phase === 'replaying');
            if (phase === 'live') setMasterLiveness(current => ({ ...current, liveOrchestrator: true }));
          }
        },
        isTerminal: (ev) => ev.event === 'done' || ev.event === 'error' || ev.event === 'master_boot_failed',
      });

      try {
        try {
          await client.run();
        } finally {
          if (!isActive()) eventPump.discard();
          await eventPump.flush();
        }
        return isActive() ? 'completed' : 'cancelled';
      } catch (e) {
        if ((e as Error).name === 'AbortError' || !isActive()) return 'cancelled';
        setMasterLiveness(unconfirmedCompanyLiveness);
        if (opts.suppressError?.(e as Error)) return 'completed';
        streamSetError(companySessionId, companyStreamError(e));
        return 'failed';
      } finally {
        // A superseded stream must never tear down the replacement connection.
        if (
          lifecycleGenerationRef.current === generation
          && abortRef.current === ctrl
        ) {
          abortRef.current = null;
          streamSetConnected(companySessionId, false);
        }
      }
    },
    [
      companySessionId,
      onSSEEvent,
      loadKanbanFromDB,
      streamSetConnected,
      streamSetConnectionPhase,
      streamSetError,
    ],
  );

  // ─── Public actions ──────────────────────────────────────────

  const start = useCallback(
    async (userMessage: string, attachments?: AgentAttachment[], opts?: { thinking?: boolean }) => {
      if (companySessionId == null || !mountedRef.current) return;
      const isCurrent = beginCompanyStreamRequest(lifecycleGenerationRef, requestGenerationRef, abortRef, mountedRef);
      lastSeenSeqRef.current = -1;
      lastSeenBusIdRef.current = null;
      streamReset(companySessionId);
      streamSetStarted(companySessionId, true);
      streamSetConnected(companySessionId, false);
      streamSetUserMessage(companySessionId, userMessage);
      setMasterLiveness(unconfirmedCompanyLiveness);
      await openStream({
        isCurrent,
        url: routeUrl('/start'),
        method: 'POST',
        body: {
          user_message: userMessage,
          attachments: attachments?.length ? attachments : undefined,
          thinking: opts?.thinking || undefined,
        },
      });
    },
    [companySessionId, routeUrl, openStream, streamReset, streamSetStarted, streamSetConnected, streamSetUserMessage],
  );

  const resume = useCallback(
    async (message: string, attachments?: AgentAttachment[], opts?: { thinking?: boolean }) => {
      if (companySessionId == null || !mountedRef.current) return;
      const isCurrent = beginCompanyStreamRequest(lifecycleGenerationRef, requestGenerationRef, abortRef, mountedRef);
      streamSetStarted(companySessionId, true);
      streamSetConnected(companySessionId, false);
      streamSetError(companySessionId, null);
      setMasterLiveness(unconfirmedCompanyLiveness);
      await openStream({
        isCurrent,
        url: routeUrl('/resume'),
        method: 'POST',
        body: {
          message,
          attachments: attachments?.length ? attachments : undefined,
          thinking: opts?.thinking || undefined,
        },
      });
    },
    [companySessionId, routeUrl, openStream, streamSetStarted, streamSetConnected, streamSetError],
  );

  const reattach = useCallback(async () => {
    if (companySessionId == null || !mountedRef.current) return;
    const isCurrent = beginCompanyStreamRequest(lifecycleGenerationRef, requestGenerationRef, abortRef, mountedRef);
    // First decide whether there's actually an alive master to attach
    // to. The new /state-snapshot endpoint always returns 200 (when the
    // session exists) with `liveOrchestrator` + `masterAlive` flags +
    // the same payload `/sessions/:id` returns. This pre-flight kills
    // the "Iniciando Master..." deadlock: if the master already ended,
    // /attach 200 would still hang the UI waiting for events that will
    // never come, because the SSE replay carries only past `session_idle`
    // (which used to be a no-op when masterState was null).
    streamSetError(companySessionId, null);
    await loadKanbanFromDB(isCurrent);
    if (!isCurrent()) return;
    type StateSnapshotLiveness = InitialFetchResponse & {
      liveOrchestrator?: boolean;
      masterAlive?: boolean;
      pendingMasterInboxCount?: number;
    };
    let snapshot: StateSnapshotLiveness | null = null;
    try {
      const r = await fetch(routeUrl('/state-snapshot'));
      if (r.ok) snapshot = (await r.json()) as StateSnapshotLiveness;
    } catch {
      /* fall through to /attach optimistic path */
    }
    if (!isCurrent()) return;
    // Latch the liveness flags so the UI can read them while deciding
    // whether to show a spinner, the standby badge, or the wake CTA.
    if (snapshot) {
      if (snapshot.masterPrompts?.length) streamHydrateMasterPromptsAction(companySessionId, snapshot.masterPrompts);
      const master = snapshot.agentRuns?.filter((run) => run.role === 'master').at(-1);
      if (master) streamApplyAgentStatus(companySessionId, {
        agentRunId: master.id, role: 'master', status: master.status, message: master.status_message,
        coderSessionId: master.coder_session_id,
      });
      setMasterLiveness({
        masterAlive: !!snapshot.masterAlive,
        liveOrchestrator: !!snapshot.liveOrchestrator,
        pendingMasterInboxCount: snapshot.pendingMasterInboxCount ?? 0,
      });
    }
    // No orchestrator OR master finished: hydrate from DB and stop.
    // The UI renders the master-idle/standby pill via the phase
    // indicator selector — never the loader.
    if (snapshot && (
      !snapshot.liveOrchestrator
      || (!snapshot.masterAlive && !transport?.keepAttachedWhileOrchestratorLive)
    )) {
      streamSetStarted(companySessionId, false);
      streamSetConnected(companySessionId, false);
      await loadFinalStateFromDB(isCurrent);
      return;
    }
    // Otherwise master is alive: keep the optimistic loader until the
    // first agent_status event arrives via SSE. The /attach 404 fallback
    // below also remains as a belt-and-suspenders for the rare race
    // where the orchestrator dies between snapshot and attach.
    streamSetStarted(companySessionId, true);
    streamSetConnected(companySessionId, false);
    let attached = false;
    try {
      if (!isCurrent()) return;
      const outcome = await openStream({
        isCurrent,
        url: routeUrl('/attach'),
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
      attached = outcome === 'completed' && isCurrent();
    } finally {
      if (attached && isCurrent()) {
        await loadFinalStateFromDB(isCurrent);
      }
    }
  }, [
    companySessionId,
    transport?.keepAttachedWhileOrchestratorLive,
    routeUrl,
    openStream,
    streamHydrateMasterPromptsAction,
    streamApplyAgentStatus,
    streamSetStarted,
    streamSetConnected,
    streamSetError,
    loadKanbanFromDB,
    loadFinalStateFromDB,
  ]);

  const pause = useCallback(async () => {
    if (companySessionId == null || !mountedRef.current) return false;
    const isCurrent = beginCompanyStreamRequest(lifecycleGenerationRef, requestGenerationRef, abortRef, mountedRef);
    try {
      const response = await fetch(routeUrl('/pause'), { method: 'POST' });
      if (!isCurrent()) return false;
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      abortRef.current?.abort();
      setMasterLiveness(unconfirmedCompanyLiveness);
      streamSetStarted(companySessionId, false);
      streamSetConnected(companySessionId, false);
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      setMasterLiveness(unconfirmedCompanyLiveness);
      streamSetConnected(companySessionId, false);
      streamSetError(companySessionId, error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [companySessionId, routeUrl, streamSetConnected, streamSetError, streamSetStarted]);

  const abort = useCallback(async () => {
    if (companySessionId == null || !mountedRef.current) return;
    const isCurrent = beginCompanyStreamRequest(lifecycleGenerationRef, requestGenerationRef, abortRef, mountedRef);
    try {
      await fetch(routeUrl('/abort'), { method: 'POST' });
    } catch {
      /* ignore */
    }
    if (isCurrent()) {
      setMasterLiveness(unconfirmedCompanyLiveness);
      streamSetConnected(companySessionId, false);
    }
  }, [companySessionId, routeUrl, streamSetConnected]);

  const sendMessage = useCallback(
    async (
      message: string,
      attachments?: AgentAttachment[],
      opts?: { thinking?: boolean; interject?: boolean },
    ) => {
      if (companySessionId == null || !mountedRef.current) return;
      try {
        const res = await fetch(routeUrl('/message'), {
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
    [companySessionId, routeUrl, streamSetError, streamSetStarted, reattach],
  );

  const respondToPrompt = useCallback(async (promptId: string, reply: MasterReply) => {
    if (companySessionId == null || !mountedRef.current) return;
    const generation = lifecycleGenerationRef.current;
    let reattached = false;
    const followMaster = () => {
      if (reattached) return;
      reattached = true;
      streamSetStarted(companySessionId, true);
      void reattach();
    };
    await submitMasterReply({
      sessionId: companySessionId,
      promptId,
      url: routeUrl,
      isCurrent: () => mountedRef.current && generation === lifecycleGenerationRef.current,
      onResolved: (prompt, fromReceipt) => {
        streamApplyMasterPrompt(companySessionId, prompt);
        if (fromReceipt && prompt.status === 'answered' && !useCompanyStore.getState().streams.get(companySessionId)?.connected) {
          followMaster();
        }
      },
      onResumed: followMaster,
    }, reply);
  }, [companySessionId, routeUrl, streamApplyMasterPrompt, streamSetStarted, reattach]);

  const respondToMasterPlan = useCallback(
    (promptId: string, approved: boolean, feedback?: string) => respondToPrompt(promptId, { approved, feedback }),
    [respondToPrompt],
  );
  const respondToMasterQuestion = useCallback(
    (promptId: string, answer: string) => respondToPrompt(promptId, { answer }),
    [respondToPrompt],
  );

  const switchProvider = useCallback(
    async (
      provider: string,
      model?: string,
      roleAssignments?: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[] }>,
    ) => {
      if (companySessionId == null || !mountedRef.current) return;
      if (!transport?.allowRuntimeSwitch) {
        streamSetError(companySessionId, 'Use the App Studio team editor to change this runtime.');
        return;
      }
      try {
        const res = await fetch(routeUrl('/switch'), {
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
    [companySessionId, transport?.allowRuntimeSwitch, routeUrl, streamSetError],
  );

  const hydrateMasterPrompts = useCallback(
    (prompts: MasterPrompt[]) => {
      if (companySessionId == null || !mountedRef.current) return;
      streamHydrateMasterPromptsAction(companySessionId, prompts);
    },
    [companySessionId, streamHydrateMasterPromptsAction],
  );

  const reset = useCallback(() => {
    if (companySessionId == null || !mountedRef.current) return;
    beginCompanyStreamRequest(lifecycleGenerationRef, requestGenerationRef, abortRef, mountedRef);
    lastSeenSeqRef.current = -1;
    lastSeenBusIdRef.current = null;
    receivedDoneRef.current = false;
    setMasterLiveness({ masterAlive: false, pendingMasterInboxCount: 0, liveOrchestrator: false });
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
    if (companySessionId == null || !mountedRef.current) return null;
    const generation = lifecycleGenerationRef.current;
    const request = requestGenerationRef.current;
    try {
      const r = await fetch(routeUrl('/wake-master'), {
        method: 'POST',
      });
      if (!r.ok) return null;
      const body = (await r.json()) as { revived: boolean; reason?: string };
      if (!mountedRef.current || generation !== lifecycleGenerationRef.current || request !== requestGenerationRef.current) return body;
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
  }, [companySessionId, routeUrl]);

  // Per-agent (subordinate) control — pause / resume / delete. Lives in a
  // dedicated hook to keep this file from growing further.
  const { pauseAgent, resumeAgent, deleteAgent } = useAgentControls(
    companySessionId,
    streamSetError,
    transport?.allowDirectAgentControls === false ? null : undefined,
  );

  useEffect(() => onCompanyPanelChange(({ sessionId, change }) => {
    if (sessionId !== companySessionId || !mountedRef.current) return;
    if (change.kind === 'agent_deleted') {
      removedRuns.add(change.agentRunId);
      streamRemoveSubordinate(sessionId, change.agentRunId);
    } else if (change.kind === 'agent_paused' || change.kind === 'agent_resumed') {
      if (removedRuns.has(change.agent.agentRunId)) return;
      // Connected streams own event order. An offline view gets the durable
      // status from the receipt and observes a newly resumed worker once.
      if (!abortRef.current) {
        streamApplyAgentStatus(sessionId, change.agent);
        if (change.kind === 'agent_resumed') void reattach();
      }
    }
    setTeamRevision(n => n + 1);
  }), [companySessionId, removedRuns, streamRemoveSubordinate, streamApplyAgentStatus, reattach]);

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
    /** Monotonic invalidation key for App agent overview/status/inbox data. */
    teamRevision,
    workspaceRevision,
    start,
    resume,
    reattach,
    pause,
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
    attachments?: import('@mcp/company-contracts').BoardAttachment[];
    id: string;
    seq: number;
    author_role: string;
    agent_run_id: string | null;
    kind: string;
    content: string;
    mentions: string[];
    created_at: string;
  }>;
  agentRuns?: Array<{
    id: string;
    role: string;
    coder_session_id: string;
    status: AgentStreamState['status'];
    status_message: string;
  }>;
  masterPrompts?: MasterPrompt[];
}
