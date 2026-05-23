import { useCallback, useRef, useState } from 'react';
import { openStream } from './openStream.js';
import type {
  AgentAttachment,
  SessionPatch,
  SessionState,
  StreamTask,
  StreamTaskExecutionMode,
} from './types.js';
import { EMPTY_STATE } from './types.js';

/**
 * Streams a coder session message via SSE (POST /api/coder/sessions/:id/messages).
 *
 * Uses fetch + ReadableStream parser instead of EventSource because EventSource
 * does not support POST + body.
 *
 * Blocks are kept in arrival order so the rendering matches what the model
 * actually emitted (text → tool_use → text → tool_use, etc.).
 */
export function useAgentStream(sessionId: number | null) {
  // All streaming state is keyed by sessionId so background runs in other
  // sessions never bleed into the currently-viewed session. Switching tabs
  // never interrupts an in-flight run; coming back shows it where it was.
  const [stateMap, setStateMap] = useState<Record<number, SessionState>>({});
  const abortMap = useRef<Map<number, AbortController>>(new Map());

  const updateSession = useCallback((sid: number, patch: SessionPatch) => {
    setStateMap((prev) => {
      const cur = prev[sid] ?? EMPTY_STATE;
      const next = typeof patch === 'function' ? patch(cur) : patch;
      return { ...prev, [sid]: { ...cur, ...next } };
    });
  }, []);

  const active: SessionState = sessionId !== null ? (stateMap[sessionId] ?? EMPTY_STATE) : EMPTY_STATE;

  const reset = useCallback(() => {
    if (sessionId === null) return;
    updateSession(sessionId, { currentTurn: null, doneReason: null, error: null });
  }, [sessionId, updateSession]);

  const runStream = useCallback(
    (sid: number, opts: Parameters<typeof openStream>[1], onMessageComplete?: () => void) =>
      openStream(sid, opts, { updateSession, abortMap: abortMap.current }, onMessageComplete),
    [updateSession],
  );

  const sendMessage = useCallback(
    async (
      content: string,
      onMessageComplete?: () => void,
      extras?: {
        attachments?: AgentAttachment[];
        /** Agent preset: explore | plan | build | admin. */
        agent?: 'explore' | 'plan' | 'build' | 'admin';
        /** Tool tier profile override (takes precedence over agent). */
        profile?: 'bootstrap' | 'navigate' | 'full' | 'auto';
        /** Override max turns for this run. null/undefined = use default. */
        maxTurns?: number | null;
        /** Enable thinking/reasoning mode. */
        thinking?: boolean;
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
      },
    ) => {
      if (!sessionId) return;
      const sid = sessionId;
      // Clear any prior 409 handshake — a successful send or a fresh attempt
      // both reset the slot. The catch path in openStream re-populates it
      // when the server responds with INTERACTION_PENDING again.
      updateSession(sid, { interactionPending: null });
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
            interject: extras?.interject || undefined,
            selected_skill_ids:
              extras?.selectedSkillIds && extras.selectedSkillIds.length > 0
                ? extras.selectedSkillIds
                : undefined,
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
      const lastSeq = stateMap[sid]?.lastSeenSeq ?? -1;
      await runStream(
        sid,
        {
          url: `/api/coder/sessions/${sid}/attach`,
          method: 'GET',
          lastEventId: lastSeq,
          reattach: true,
        },
        onMessageComplete,
      );
    },
    [runStream, stateMap],
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
    try {
      await fetch(`/api/coder/sessions/${sessionId}/abort`, { method: 'POST' });
    } catch {
      /* ignore */
    }
    abortMap.current.get(sessionId)?.abort();
  }, [sessionId]);

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
      extras?: { agent?: 'explore' | 'plan' | 'build' | 'admin' },
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
      approved: boolean,
      feedback?: string,
      onMessageComplete?: () => void,
      extras?: { agent?: 'explore' | 'plan' | 'build' | 'admin' },
    ) =>
      postAndResume(
        `/api/coder/sessions/${sessionId}/plan-response`,
        { approved, feedback },
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
      extras?: { agent?: 'explore' | 'plan' | 'build' | 'admin' },
    ) =>
      postAndResume(
        `/api/coder/sessions/${sessionId}/tasks-response`,
        verdict as Record<string, unknown>,
        { plan_mode: true, ...(extras?.agent ? { agent: extras.agent } : {}) },
        onMessageComplete,
      ),
    [sessionId, postAndResume],
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
    currentTurn: active.currentTurn,
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
    sidebarRefreshTick: active.sidebarRefreshTick,
    snapshotTick: active.snapshotTick,
    toolLoopInterventions: active.toolLoopInterventions,
    sendMessage,
    sendWithInterject,
    dismissInteractionPending,
    reattach,
    abort,
    reset,
    clearCurrentTurn,
    answerQuestion,
    respondToPlan,
    respondToTasks,
    switchProvider,
  };
}
