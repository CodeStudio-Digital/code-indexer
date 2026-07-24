import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { AgentPreset, IdeContextInput } from '@mcp/api-bus';
import { openStream } from './openStream.js';
import type {
  AgentAttachment,
  AssistantTurn,
  DecisionAnswers,
  SessionState,
  StreamTask,
  StreamTaskExecutionMode,
} from './types.js';
import { createAbortedSessionPatch } from './abort-state.js';
import type { NotificationSourceContext } from '../../features/notifications/index.js';
import {
  agentStreamAbortFallbackTimerMap,
  agentStreamAbortMap,
  agentStreamAbortRequestMap,
  agentStreamLastSeenBusIdMap,
  agentStreamLastSeenSeqMap,
  agentStreamOwnership,
  getAgentCurrentTurnSnapshot,
  getAgentSessionSnapshot,
  readAgentStreamCursor,
  subscribeAgentCurrentTurn,
  subscribeAgentSession,
  updateAgentSession,
} from './session-stream-store.js';

const ABORT_TERMINAL_EVENT_GRACE_MS = 2_000;

/** Subscribe only the narrow live-transcript surfaces to token/tool frames. */
export function useAgentCurrentTurn(sessionId: number | null): AssistantTurn | null {
  const subscribe = useCallback(
    (listener: () => void) => subscribeAgentCurrentTurn(sessionId, listener),
    [sessionId],
  );
  const getSnapshot = useCallback(
    () => getAgentCurrentTurnSnapshot(sessionId),
    [sessionId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Streams a coder session message via SSE (POST /api/coder/sessions/:id/messages).
 *
 * Uses fetch + ReadableStream parser instead of EventSource because EventSource
 * does not support POST + body.
 *
 * Blocks are kept in arrival order so the rendering matches what the model
 * actually emitted (text → tool_use → text → tool_use, etc.).
 */
export function useAgentStream(sessionId: number | null, notificationContext?: NotificationSourceContext) {
  const consumerIdRef = useRef(Symbol('agent-stream-consumer'));
  const notificationContextRef = useRef(notificationContext);
  notificationContextRef.current = notificationContext;

  // Unmount releases only this surface's refetch callback. The transport,
  // cursor and live state belong to the renderer process and remain available
  // to another visible surface or to this surface after a remount.
  useEffect(() => {
    const consumerId = consumerIdRef.current;
    return () => {
      if (sessionId !== null) {
        agentStreamOwnership.releaseConsumer(consumerId, sessionId);
      }
    };
  }, [sessionId]);

  const subscribe = useCallback(
    (listener: () => void) => subscribeAgentSession(sessionId, listener),
    [sessionId],
  );
  const getSnapshot = useCallback(
    () => getAgentSessionSnapshot(sessionId),
    [sessionId],
  );
  const active: SessionState = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  const updateSession = updateAgentSession;

  const reset = useCallback(() => {
    if (sessionId === null) return;
    updateSession(sessionId, { currentTurn: null, doneReason: null, error: null });
  }, [sessionId, updateSession]);

  const runStream = useCallback(
    (
      sid: number,
      opts: Parameters<typeof openStream>[1],
      onMessageComplete?: () => void,
    ) => agentStreamOwnership.run(
      sid,
      consumerIdRef.current,
      opts.method === 'GET' ? 'attach' : 'command',
      onMessageComplete,
      (notifyMessageComplete) => openStream(
        sid,
        opts,
        {
          updateSession,
          abortMap: agentStreamAbortMap,
          lastSeenSeqMap: agentStreamLastSeenSeqMap,
          lastSeenBusIdMap: agentStreamLastSeenBusIdMap,
          notificationContext: notificationContextRef.current,
        },
        notifyMessageComplete,
      ),
    ),
    [],
  );

  const sendMessage = useCallback(
    async (
      content: string,
      onMessageComplete?: () => void,
      extras?: {
        attachments?: AgentAttachment[];
        /** Agent preset selected for this run. Undefined keeps the session preset. */
        agent?: AgentPreset;
        /** Tool tier profile override (takes precedence over agent). */
        profile?: 'bootstrap' | 'navigate' | 'full' | 'auto';
        /** Override max turns for this run. null/undefined = use default. */
        maxTurns?: number | null;
        /** Enable thinking/reasoning mode. */
        thinking?: boolean;
        /** Force the vision fallback (image → text via the configured vision
         *  model) even on vision-capable models. Auto-applies for blind models. */
        describeImages?: boolean;
        /**
         * When true and a live run is currently blocked inside an interactive
         * tool, ask the server to break the wait (`interruptWait`) and inject
         * this message. Default false — the canonical answer flow is /answer
         * or /plan-response. Set this to true to deliberately redirect a
         * mid-loop master.
         */
        interject?: boolean;
        /**
         * Skill IDs the user pre-selected in the sidebar. The server expands
         * them into an `<active_skills>` block prepended to the user message
         * before passing to runCoder.
         */
        selectedSkillIds?: string[];
        /**
         * Structured IDE context (active file / selections / open tabs) captured
         * at send time. Forwarded to runCoder and rendered as an `<ide_context>`
         * block on this turn's user message.
         */
        ideContext?: IdeContextInput;
        /**
         * True when this is the FIRST message of a fresh session — the backend
         * runs the blocking task-preflight before streaming. Drives the
         * "Analyzing the task…" indicator during that wait.
         */
        freshSession?: boolean;
      },
    ) => {
      if (!sessionId) return;
      const sid = sessionId;
      // Clear any prior 409 handshake — a successful send or a fresh attempt
      // both reset the slot. The catch path in openStream re-populates it
      // when the server responds with INTERACTION_PENDING again.
      updateSession(sid, { interactionPending: null });
      // Fresh first message → preflight runs (blocking) before the stream
      // opens; show the "Analyzing the task…" indicator until the first event.
      if (extras?.freshSession) {
        updateSession(sid, { preflight: { startedAt: Date.now() } });
      }
      await runStream(
        sid,
        {
          url: `/api/coder/sessions/${sid}/messages`,
          method: 'POST',
          body: {
            content,
            attachments: extras?.attachments,
            agent: extras?.agent,
            profile: extras?.profile,
            max_turns: extras?.maxTurns ?? undefined,
            thinking: extras?.thinking || undefined,
            describe_images: extras?.describeImages || undefined,
            interject: extras?.interject || undefined,
            selected_skill_ids:
              extras?.selectedSkillIds && extras.selectedSkillIds.length > 0
                ? extras.selectedSkillIds
                : undefined,
            ide_context: extras?.ideContext,
          },
        },
        onMessageComplete,
      );
    },
    [sessionId, runStream, updateSession],
  );

  /**
   * Resend the most recent message that was rejected with
   * 409 INTERACTION_PENDING, this time asking the server to interrupt
   * the runner's interactive wait. No-op if there is no pending handshake.
   */
  const sendWithInterject = useCallback(
    async (onMessageComplete?: () => void) => {
      if (sessionId === null) return;
      const pending = active.interactionPending;
      if (!pending) return;
      await sendMessage(pending.pendingContent, onMessageComplete, { interject: true });
    },
    [sessionId, active.interactionPending, sendMessage],
  );

  /** Discard the 409 handshake without resending. */
  const dismissInteractionPending = useCallback(() => {
    if (sessionId === null) return;
    updateSession(sessionId, { interactionPending: null });
  }, [sessionId, updateSession]);

  /**
   * Reattach to an in-flight run after the tab was closed/reopened.
   * Uses Last-Event-ID to skip events already rendered in this session,
   * or starts from the buffer head when lastSeenSeq is -1.
   */
  const reattach = useCallback(
    async (sid: number, onMessageComplete?: () => void) => {
      const { busId: lastBusId, seq: lastSeq } = readAgentStreamCursor(sid);
      const initialBlocks = lastBusId && lastSeq >= 0
        ? getAgentSessionSnapshot(sid).currentTurn?.blocks
        : undefined;
      await runStream(
        sid,
        {
          url: `/api/coder/sessions/${sid}/attach`,
          method: 'GET',
          lastEventId: lastSeq,
          lastEventBusId: lastBusId,
          reattach: true,
          initialBlocks,
        },
        onMessageComplete,
      );
    },
    [runStream],
  );

  /** Clear the streaming-in-progress turn. Called by AgentChat after the
   *  persisted session has been refetched, to avoid showing the same content
   *  twice (once from the live buffer, once from the DB). */
  const clearCurrentTurn = useCallback(() => {
    if (sessionId === null) return;
    updateSession(sessionId, { currentTurn: null });
  }, [sessionId, updateSession]);

  const abort = useCallback(async () => {
    if (sessionId === null) return;
    const sid = sessionId;
    const pending = agentStreamAbortRequestMap.get(sid);
    if (pending) {
      await pending;
      return;
    }

    const controller = agentStreamAbortMap.get(sid);
    const finalizeLocally = () => {
      // A terminal event already closed this stream, or a newer run replaced
      // it. In either case, never let an old Stop clobber the newer state.
      if (controller) {
        if (agentStreamAbortMap.get(sid) !== controller) return;
        controller.abort();
      } else if (agentStreamAbortMap.has(sid)) {
        return;
      }
      updateSession(sid, (state) => createAbortedSessionPatch(state));
    };

    // The worker emits operation_end/done after abort. Keep this SSE alive long
    // enough to receive those events; closing it immediately is what left the
    // provider activity pill stuck on "running". The timer is only a safety net
    // for a dead worker/transport and is identity-guarded against a newer run.
    const previousTimer = agentStreamAbortFallbackTimerMap.get(sid);
    if (previousTimer) clearTimeout(previousTimer);
    const fallbackTimer = setTimeout(() => {
      agentStreamAbortFallbackTimerMap.delete(sid);
      finalizeLocally();
    }, ABORT_TERMINAL_EVENT_GRACE_MS);
    agentStreamAbortFallbackTimerMap.set(sid, fallbackTimer);

    const request = (async () => {
      try {
        const response = await fetch(`/api/coder/sessions/${sid}/abort`, { method: 'POST' });
        if (!response.ok) finalizeLocally();
      } catch {
        // Preserve the existing best-effort Stop contract. If the control
        // request itself fails, at least terminate the stale local UI state.
        finalizeLocally();
      }
    })();
    agentStreamAbortRequestMap.set(sid, request);
    try {
      await request;
    } finally {
      if (agentStreamAbortRequestMap.get(sid) === request) {
        agentStreamAbortRequestMap.delete(sid);
      }
    }
  }, [sessionId, updateSession]);

  const postAndResume = useCallback(
    async (
      url: string,
      body: Record<string, unknown>,
      resumeBody: Record<string, unknown>,
      onMessageComplete?: () => void,
    ) => {
      if (!sessionId) return;
      const sid = sessionId;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as {
        resumed?: boolean;
        // Apêndice 4 Fase 2 — the answer landed in the DB but the
        // previous worker is gone. We need to spawn a fresh worker
        // run from history via POST /messages instead of /continue
        // (which would start a conflicting in-process runner).
        resumed_via_worker?: boolean;
      };
      if (json.resumed) {
        await runStream(
          sid,
          { url: `/api/coder/sessions/${sid}/continue`, method: 'POST', body: resumeBody },
          onMessageComplete,
        );
      } else if (json.resumed_via_worker) {
        await runStream(
          sid,
          {
            url: `/api/coder/sessions/${sid}/messages`,
            method: 'POST',
            body: { content: '', resume: true, ...resumeBody },
          },
          onMessageComplete,
        );
      }
    },
    [sessionId, runStream],
  );

  const answerQuestion = useCallback(
    (
      answer: string,
      onMessageComplete?: () => void,
      extras?: { agent?: AgentPreset },
    ) =>
      postAndResume(
        `/api/coder/sessions/${sessionId}/answer`,
        { answer },
        extras?.agent ? { agent: extras.agent } : {},
        onMessageComplete,
      ),
    [sessionId, postAndResume],
  );

  const respondToPlan = useCallback(
    (
      verdict: { approved: boolean; aborted?: boolean; feedback?: string },
      onMessageComplete?: () => void,
      extras?: { agent?: AgentPreset },
    ) => {
      // Stay-in-Build: on APPROVAL the plan→build transition already happened
      // server-side (agent persisted to `build`), so the resume must NOT forward
      // `plan_mode: true` — that would re-enter plan mode and push the model to
      // submit a second plan. Carry the resulting agent (`build`) instead. Only a
      // rejected/aborted verdict stays in plan mode to revise.
      const resumeBody =
        verdict.approved && !verdict.aborted
          ? { agent: extras?.agent ?? ('build' as const) }
          : { plan_mode: true, ...(extras?.agent ? { agent: extras.agent } : {}) };
      return postAndResume(
        `/api/coder/sessions/${sessionId}/plan-response`,
        { approved: verdict.approved, feedback: verdict.feedback, aborted: verdict.aborted },
        resumeBody,
        onMessageComplete,
      );
    },
    [sessionId, postAndResume],
  );

  const decideGate = useCallback(
    (
      answers: DecisionAnswers,
      onMessageComplete?: () => void,
      extras?: { agent?: AgentPreset },
    ) =>
      postAndResume(
        `/api/coder/sessions/${sessionId}/decide`,
        { answers },
        { plan_mode: true, ...(extras?.agent ? { agent: extras.agent } : {}) },
        onMessageComplete,
      ),
    [sessionId, postAndResume],
  );

  const respondToTasks = useCallback(
    (
      verdict: {
        approved: boolean;
        feedback?: string;
        tasks?: StreamTask[];
        execution_mode?: StreamTaskExecutionMode;
      },
      onMessageComplete?: () => void,
      extras?: { agent?: AgentPreset },
    ) =>
      postAndResume(
        `/api/coder/sessions/${sessionId}/tasks-response`,
        verdict as Record<string, unknown>,
        { plan_mode: true, ...(extras?.agent ? { agent: extras.agent } : {}) },
        onMessageComplete,
      ),
    [sessionId, postAndResume],
  );

  const respondToSpec = useCallback(
    (
      approved: boolean,
      spec_path: string,
      requested_changes?: string,
      onMessageComplete?: () => void,
      extras?: { agent?: AgentPreset },
    ) =>
      postAndResume(
        `/api/coder/sessions/${sessionId}/spec-response`,
        { approved, spec_path, requested_changes },
        { ...(extras?.agent ? { agent: extras.agent } : {}) },
        onMessageComplete,
      ),
    [sessionId, postAndResume],
  );

  /**
   * Resolve a PermissionGate approval (tool paused before execution).
   * Optimistically drops the request from `pendingApprovals` — the
   * authoritative `tool_approval_resolved` event follows over SSE.
   * `postAndResume` covers the dead-runner fallback (the server sealed
   * the dangling tool_use in the DB and asked us to resume).
   */
  const respondToToolApproval = useCallback(
    (
      toolUseId: string,
      verdict: { approved: boolean; note?: string; alwaysAllow?: boolean },
    ) => {
      if (sessionId) {
        updateSession(sessionId, (s) => ({
          pendingApprovals: s.pendingApprovals.filter((a) => a.toolUseId !== toolUseId),
        }));
      }
      return postAndResume(
        `/api/coder/sessions/${sessionId}/tool-approval`,
        {
          tool_use_id: toolUseId,
          approved: verdict.approved,
          note: verdict.note,
          always_allow: verdict.alwaysAllow,
        },
        {},
      );
    },
    [sessionId, postAndResume, updateSession],
  );

  const switchProvider = useCallback(
    async (provider: string, model?: string) => {
      if (!sessionId) return;
      await fetch(`/api/coder/sessions/${sessionId}/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model }),
      });
    },
    [sessionId],
  );

  return {
    streaming: active.streaming,
    doneReason: active.doneReason,
    error: active.error,
    lastUsage: active.lastUsage,
    runDelta: active.runDelta,
    reattached: active.reattached,
    todos: active.todos,
    contextStatus: active.contextStatus,
    indexStatus: active.indexStatus,
    interactionPending: active.interactionPending,
    pipelineRuntime: active.pipelineRuntime,
    activeProcesses: active.activeProcesses,
    sidebarRefreshTick: active.sidebarRefreshTick,
    tasksRefreshTick: active.tasksRefreshTick,
    snapshotTick: active.snapshotTick,
    pendingApprovals: active.pendingApprovals,
    lastEventAt: active.lastEventAt,
    preflight: active.preflight,
    sendMessage,
    sendWithInterject,
    dismissInteractionPending,
    reattach,
    abort,
    reset,
    clearCurrentTurn,
    answerQuestion,
    respondToPlan,
    decideGate,
    respondToTasks,
    respondToSpec,
    respondToToolApproval,
    switchProvider,
  };
}
