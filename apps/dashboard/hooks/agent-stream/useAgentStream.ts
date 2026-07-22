import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AgentPreset, IdeContextInput } from '@mcp/api-bus';
import { openStream } from './openStream.js';
import type {
  AgentAttachment,
  AssistantTurn,
  DecisionAnswers,
  SessionPatch,
  SessionState,
  StreamTask,
  StreamTaskExecutionMode,
} from './types.js';
import { EMPTY_STATE } from './types.js';
import { pruneSessions } from './prune-sessions.js';
import { createAbortedSessionPatch } from './abort-state.js';
import type { NotificationSourceContext } from '../../features/notifications/index.js';

const ABORT_TERMINAL_EVENT_GRACE_MS = 2_000;

const currentTurns = new Map<number, AssistantTurn | null>();
const currentTurnListeners = new Map<number, Set<() => void>>();

function publishCurrentTurn(sessionId: number, turn: AssistantTurn | null): void {
  if ((currentTurns.get(sessionId) ?? null) === turn) return;
  if (turn) currentTurns.set(sessionId, turn);
  else currentTurns.delete(sessionId);
  for (const listener of currentTurnListeners.get(sessionId) ?? []) listener();
}

function currentTurnSnapshot(sessionId: number | null): AssistantTurn | null {
  return sessionId === null ? null : (currentTurns.get(sessionId) ?? null);
}

/** Subscribe only the narrow live-transcript surfaces to token/tool frames. */
export function useAgentCurrentTurn(sessionId: number | null): AssistantTurn | null {
  const subscribe = useCallback((listener: () => void) => {
    if (sessionId === null) return () => {};
    let listeners = currentTurnListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      currentTurnListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) currentTurnListeners.delete(sessionId);
    };
  }, [sessionId]);
  const getSnapshot = useCallback(() => currentTurnSnapshot(sessionId), [sessionId]);
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
  // All streaming state is keyed by sessionId so background runs in other
  // sessions never bleed into the currently-viewed session. Switching tabs
  // never interrupts an in-flight run; coming back shows it where it was.
  const [stateMap, setStateMap] = useState<Record<number, SessionState>>({});
  // Authoritative synchronous mirror. Live-turn-only patches update this ref
  // and the narrow external store without scheduling a render of the shell.
  const stateMapRef = useRef<Record<number, SessionState>>({});
  const abortMap = useRef<Map<number, AbortController>>(new Map());
  const abortRequestMap = useRef<Map<number, Promise<void>>>(new Map());
  const abortFallbackTimerMap = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const notificationContextRef = useRef(notificationContext);
  notificationContextRef.current = notificationContext;
  // Highest SSE id per sid for reattach Last-Event-ID. A ref (not React
  // state) because openStream advances it on every event — see OpenStreamDeps.
  const lastSeenSeqRef = useRef<Map<number, number>>(new Map());
  // Last-touched timestamp per sid, for LRU eviction in `pruneSessions`.
  const touchedRef = useRef<Map<number, number>>(new Map());
  // Mirror the active sessionId into a ref so `updateSession` (stable identity,
  // empty deps) can read the current value without going stale.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Abort every stream this instance opened when the host unmounts. Without
  // this, a remount leaves the old instance's streams alive as zombies that
  // keep feeding the module-level worker-log store. The RUN is unaffected —
  // the server bus decouples run from client; the next mount's auto-reattach
  // reconnects. openStream's finally is guarded by `abortMap.get(sid) === ctrl`,
  // so after clear() a superseded teardown never clobbers live state.
  useEffect(() => {
    const map = abortMap.current;
    return () => {
      for (const ctrl of map.values()) ctrl.abort();
      map.clear();
      for (const timer of abortFallbackTimerMap.current.values()) clearTimeout(timer);
      abortFallbackTimerMap.current.clear();
      for (const sid of Object.keys(stateMapRef.current)) publishCurrentTurn(Number(sid), null);
    };
  }, []);

  const updateSession = useCallback((sid: number, patch: SessionPatch) => {
    touchedRef.current.set(sid, Date.now());
    const previous = stateMapRef.current;
    const current = previous[sid] ?? EMPTY_STATE;
    const next = typeof patch === 'function' ? patch(current) : patch;
    const merged = pruneSessions(
      { ...previous, [sid]: { ...current, ...next } },
      sessionIdRef.current,
      touchedRef.current,
    );
    for (const previousId of Object.keys(previous)) {
      if (!(previousId in merged)) publishCurrentTurn(Number(previousId), null);
    }
    stateMapRef.current = merged;
    if (Object.prototype.hasOwnProperty.call(next, 'currentTurn')) {
      publishCurrentTurn(sid, merged[sid]?.currentTurn ?? null);
    }
    // Token/tool flushes contain only currentTurn. Do not make every consumer
    // of useAgentStream (especially AgentChat) reconcile for those frames.
    if (Object.keys(next).some((key) => key !== 'currentTurn')) setStateMap(merged);
  }, []);

  const active: SessionState = sessionId !== null ? (stateMap[sessionId] ?? EMPTY_STATE) : EMPTY_STATE;

  const reset = useCallback(() => {
    if (sessionId === null) return;
    updateSession(sessionId, { currentTurn: null, doneReason: null, error: null });
  }, [sessionId, updateSession]);

  const runStream = useCallback(
    (sid: number, opts: Parameters<typeof openStream>[1], onMessageComplete?: () => void) =>
      openStream(
        sid,
        opts,
        {
          updateSession,
          abortMap: abortMap.current,
          lastSeenSeqMap: lastSeenSeqRef.current,
          notificationContext: notificationContextRef.current,
        },
        onMessageComplete,
      ),
    [updateSession],
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
      const pending = stateMap[sessionId]?.interactionPending;
      if (!pending) return;
      await sendMessage(pending.pendingContent, onMessageComplete, { interject: true });
    },
    [sessionId, stateMap, sendMessage],
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
      const lastSeq = lastSeenSeqRef.current.get(sid) ?? -1;
      const initialBlocks = lastSeq >= 0
        ? stateMapRef.current[sid]?.currentTurn?.blocks
        : undefined;
      await runStream(
        sid,
        {
          url: `/api/coder/sessions/${sid}/attach`,
          method: 'GET',
          lastEventId: lastSeq,
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
    const pending = abortRequestMap.current.get(sid);
    if (pending) {
      await pending;
      return;
    }

    const controller = abortMap.current.get(sid);
    const finalizeLocally = () => {
      // A terminal event already closed this stream, or a newer run replaced
      // it. In either case, never let an old Stop clobber the newer state.
      if (controller) {
        if (abortMap.current.get(sid) !== controller) return;
        controller.abort();
      } else if (abortMap.current.has(sid)) {
        return;
      }
      updateSession(sid, (state) => createAbortedSessionPatch(state));
    };

    // The worker emits operation_end/done after abort. Keep this SSE alive long
    // enough to receive those events; closing it immediately is what left the
    // provider activity pill stuck on "running". The timer is only a safety net
    // for a dead worker/transport and is identity-guarded against a newer run.
    const previousTimer = abortFallbackTimerMap.current.get(sid);
    if (previousTimer) clearTimeout(previousTimer);
    const fallbackTimer = setTimeout(() => {
      abortFallbackTimerMap.current.delete(sid);
      finalizeLocally();
    }, ABORT_TERMINAL_EVENT_GRACE_MS);
    abortFallbackTimerMap.current.set(sid, fallbackTimer);

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
    abortRequestMap.current.set(sid, request);
    try {
      await request;
    } finally {
      if (abortRequestMap.current.get(sid) === request) {
        abortRequestMap.current.delete(sid);
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
