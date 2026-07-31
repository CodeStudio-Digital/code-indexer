import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentPreset } from '@mcp/api-bus';
import { apiPatch } from '../../hooks/useApi.js';
import {
  createSerializedAsyncQueue,
} from './execution-mode-state.js';
import {
  DEFAULT_SESSION_AGENT,
  hydratedSessionAgent,
  isAgentPreset,
  mergeSessionAgentData,
} from './agent-state.js';
import type { CoderSession, SessionData, SessionId } from './types.js';

const SESSION_AGENT_CHANGED_EVENT = 'coder:session_agent_changed';

interface AgentChangedDetail {
  sessionId?: SessionId;
  agent?: string;
  session?: CoderSession;
}

interface UseSessionAgentOptions {
  selectedId: SessionId | null;
  sessionData: SessionData | null;
  updateSessionData: (fn: (previous: SessionData) => SessionData) => void;
  updateSessions?: (fn: (previous: CoderSession[]) => CoderSession[]) => void;
  refetchSession?: () => void;
  initialAgent?: AgentPreset;
}

/**
 * Shared Chat/Editor agent state.
 *
 * Selector writes are serialized and sends can wait for the acknowledged tail,
 * so a visually selected Build agent can never race a fresh Explore runner.
 */
export function useSessionAgent({
  selectedId,
  sessionData,
  updateSessionData,
  updateSessions,
  refetchSession,
  initialAgent = DEFAULT_SESSION_AGENT,
}: UseSessionAgentOptions) {
  const [agent, setAgentState] = useState<AgentPreset>(initialAgent);
  const agentRef = useRef(agent);
  const selectedIdRef = useRef(selectedId);
  const writeQueueRef = useRef(createSerializedAsyncQueue());
  const latestSelectionRef = useRef(new Map<SessionId, AgentPreset>());

  agentRef.current = agent;
  selectedIdRef.current = selectedId;

  const syncSessionAgent = useCallback((
    sessionId: SessionId,
    next: AgentPreset,
    response?: CoderSession | null,
  ): void => {
    updateSessionData((previous) => mergeSessionAgentData(
      previous,
      sessionId,
      next,
      response,
    ));
    updateSessions?.((previous) => previous.map((session) => (
      session.id === sessionId
        ? {
            ...session,
            ...(response?.id === sessionId ? response : {}),
            agent: next,
          }
        : session
    )));
  }, [updateSessionData, updateSessions]);

  const adoptAgent = useCallback((
    next: AgentPreset,
    sessionId: SessionId | null = selectedIdRef.current,
    response?: CoderSession | null,
  ): void => {
    if (sessionId != null) syncSessionAgent(sessionId, next, response);
    if (sessionId == null || selectedIdRef.current === sessionId) {
      agentRef.current = next;
      setAgentState(next);
    }
  }, [syncSessionAgent]);

  useEffect(() => {
    if (selectedId != null) {
      const optimistic = latestSelectionRef.current.get(selectedId);
      if (optimistic) {
        agentRef.current = optimistic;
        setAgentState(optimistic);
        return;
      }
    }
    const hydrated = hydratedSessionAgent(sessionData?.session, selectedId);
    if (hydrated) {
      agentRef.current = hydrated;
      setAgentState(hydrated);
    }
  }, [selectedId, sessionData?.session]);

  useEffect(() => {
    const onChanged = (event: Event): void => {
      const detail = (event as CustomEvent<AgentChangedDetail>).detail;
      if (
        !detail?.sessionId
        || !isAgentPreset(detail.agent)
        || latestSelectionRef.current.has(detail.sessionId)
      ) return;
      adoptAgent(detail.agent, detail.sessionId, detail.session);
    };
    window.addEventListener(SESSION_AGENT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SESSION_AGENT_CHANGED_EVENT, onChanged);
  }, [adoptAgent]);

  const changeAgentAndWait = useCallback((next: AgentPreset): Promise<void> => {
    const sessionId = selectedIdRef.current;
    if (sessionId == null) {
      adoptAgent(next, null);
      return Promise.resolve();
    }

    const previous = agentRef.current;
    latestSelectionRef.current.set(sessionId, next);
    adoptAgent(next, sessionId);

    const operation = writeQueueRef.current.enqueue(async () => {
      const response = await apiPatch<CoderSession>(
        `/coder/sessions/${sessionId}/agent`,
        { agent: next },
      );
      if (latestSelectionRef.current.get(sessionId) !== next) return;

      latestSelectionRef.current.delete(sessionId);
      const authoritative =
        hydratedSessionAgent(response, sessionId) ?? next;
      adoptAgent(authoritative, sessionId, response);
      window.dispatchEvent(new CustomEvent<AgentChangedDetail>(
        SESSION_AGENT_CHANGED_EVENT,
        { detail: { sessionId, agent: authoritative, session: response } },
      ));
      window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
    });

    return operation.catch((error: unknown) => {
      if (latestSelectionRef.current.get(sessionId) !== next) return;
      latestSelectionRef.current.delete(sessionId);
      adoptAgent(previous, sessionId);
      if (selectedIdRef.current === sessionId) refetchSession?.();
      console.warn(
        `[chat] agent change failed for session ${sessionId}:`,
        error,
      );
    });
  }, [adoptAgent, refetchSession]);

  const setAgent = useCallback((next: AgentPreset): void => {
    void changeAgentAndWait(next);
  }, [changeAgentAndWait]);

  const awaitPendingAgentChange = useCallback(async (): Promise<void> => {
    await writeQueueRef.current.wait();
  }, []);

  const getAgent = useCallback((): AgentPreset => agentRef.current, []);

  return {
    agent,
    setAgent,
    changeAgentAndWait,
    awaitPendingAgentChange,
    adoptAgent,
    getAgent,
  };
}
