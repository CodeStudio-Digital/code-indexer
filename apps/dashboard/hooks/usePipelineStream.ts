import { useCallback, useEffect, useRef, useState } from 'react';
import { ReconnectingSSEClient } from '@mcp/shared/sse/ReconnectingSSEClient.js';
import { apiBaseUrl } from '../lib/api-client.js';
import type {
  PipelineNodeRuntimeStatus,
  PipelineRuntimeState,
} from './agent-stream/types.js';
import { notifyPipelineStreamEvent, type NotificationSourceContext } from '../features/notifications/index.js';

const TERMINAL_PIPELINE_EVENTS = new Set([
  'pipeline_completed',
  'pipeline_aborted',
  'pipeline_failed',
]);

const pipelineStreamBackoff = {
  nextDelay(attempt: number): number {
    return Math.min(2000 * Math.pow(1.5, attempt), 30_000);
  },
};

/**
 * Subscribe to chat pipeline events for a session over a long-lived SSE
 * connection (`/api/coder/sessions/:id/pipelines/stream`). Independent
 * of the per-turn chat stream because pipelines outlive any single turn.
 *
 * Connection is gated: the hook only opens the stream after confirming a
 * pipeline execution exists for the session — either persisted (probed
 * once via `GET /pipelines/executions` on session change) or freshly
 * started (caller invokes `openStream()` right after
 * `POST /pipelines/:pid/start`). This avoids the 404-reconnect loop that
 * happens when no executor has ever been registered for the session.
 */
export function usePipelineStream(sessionId: number | null, notificationContext?: NotificationSourceContext): {
  pipelineRuntime: PipelineRuntimeState | null;
  openStream: () => void;
  reset: () => void;
} {
  const [runtime, setRuntime] = useState<PipelineRuntimeState | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const openStreamRef = useRef<() => void>(() => {});
  const notificationContextRef = useRef(notificationContext);
  notificationContextRef.current = notificationContext;

  const reset = useCallback(() => setRuntime(null), []);
  const openStream = useCallback(() => openStreamRef.current(), []);

  useEffect(() => {
    setRuntime(null);
    openStreamRef.current = () => {};
    if (sessionId == null) return;

    let cancelled = false;
    let hasOpened = false;
    let lastSeenSeq = -1;

    const handleEvent = (eventName: string, data: Record<string, unknown>) => {
      notifyPipelineStreamEvent(sessionId, eventName, data, notificationContextRef.current);

      if (eventName === 'pipeline_started') {
        const d = data as { executionId: number; pipelineId: number; startNodeId?: string };
        setRuntime({
          executionId: d.executionId,
          pipelineId: d.pipelineId,
          status: 'running',
          currentNodeId: d.startNodeId ?? null,
          nodes: d.startNodeId ? { [d.startNodeId]: { status: 'pending' } } : {},
          error: null,
        });
        return;
      }

      if (eventName === 'pipeline_node_started') {
        const d = data as {
          executionId: number;
          nodeId: string;
          nodeLabel?: string;
          kind?: 'agent' | 'validate';
        };
        setRuntime((cur) => {
          if (!cur || cur.executionId !== d.executionId) return cur;
          return {
            ...cur,
            currentNodeId: d.nodeId,
            nodes: {
              ...cur.nodes,
              [d.nodeId]: {
                ...(cur.nodes[d.nodeId] ?? {}),
                status: 'running' as PipelineNodeRuntimeStatus,
                label: d.nodeLabel ?? cur.nodes[d.nodeId]?.label,
                kind: d.kind ?? cur.nodes[d.nodeId]?.kind,
              },
            },
          };
        });
        return;
      }

      if (eventName === 'pipeline_node_completed') {
        const d = data as {
          executionId: number;
          nodeId: string;
          outcome?: string | null;
          verdict?: 'pass' | 'fail' | 'review' | null;
          outputPreview?: string;
        };
        setRuntime((cur) => {
          if (!cur || cur.executionId !== d.executionId) return cur;
          return {
            ...cur,
            nodes: {
              ...cur.nodes,
              [d.nodeId]: {
                ...(cur.nodes[d.nodeId] ?? {}),
                status: 'completed',
                verdict: d.verdict ?? null,
                outcome: d.outcome ?? null,
                outputPreview: d.outputPreview,
              },
            },
          };
        });
        return;
      }

      if (eventName === 'pipeline_node_failed') {
        const d = data as { executionId: number; nodeId: string; error?: string };
        setRuntime((cur) => {
          if (!cur || cur.executionId !== d.executionId) return cur;
          return {
            ...cur,
            nodes: {
              ...cur.nodes,
              [d.nodeId]: {
                ...(cur.nodes[d.nodeId] ?? {}),
                status: 'failed',
                error: d.error,
              },
            },
          };
        });
        return;
      }

      if (eventName === 'pipeline_paused') {
        const d = data as {
          executionId: number;
          nodeId?: string | null;
          awaitingConfirmation?: boolean;
        };
        setRuntime((cur) => {
          if (!cur || cur.executionId !== d.executionId) return cur;
          return {
            ...cur,
            status: 'paused',
            currentNodeId: d.nodeId ?? cur.currentNodeId,
            awaitingConfirmation: !!d.awaitingConfirmation,
          };
        });
        return;
      }

      if (eventName === 'pipeline_resumed') {
        const d = data as { executionId: number; nodeId?: string };
        setRuntime((cur) => {
          if (!cur || cur.executionId !== d.executionId) return cur;
          return {
            ...cur,
            status: 'running',
            currentNodeId: d.nodeId ?? cur.currentNodeId,
            awaitingConfirmation: false,
          };
        });
        return;
      }

      if (eventName === 'pipeline_completed') {
        const d = data as { executionId: number };
        setRuntime((cur) => {
          if (!cur || cur.executionId !== d.executionId) return cur;
          return { ...cur, status: 'completed', currentNodeId: null };
        });
        return;
      }

      if (eventName === 'pipeline_aborted') {
        const d = data as { executionId: number; reason?: string | null };
        setRuntime((cur) => {
          if (!cur || cur.executionId !== d.executionId) return cur;
          return {
            ...cur,
            status: 'aborted',
            currentNodeId: null,
            error: d.reason ?? null,
          };
        });
        return;
      }

      if (eventName === 'pipeline_failed') {
        const d = data as { executionId: number; error?: string };
        setRuntime((cur) => {
          if (!cur || cur.executionId !== d.executionId) return cur;
          return {
            ...cur,
            status: 'failed',
            currentNodeId: null,
            error: d.error ?? null,
          };
        });
      }
    };

    const connect = () => {
      if (cancelled) return;
      if (streamAbortRef.current) return;

      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;
      const url = `${apiBaseUrl()}/api/coder/sessions/${sessionId}/pipelines/stream`;
      const client = new ReconnectingSSEClient({
        url,
        method: 'GET',
        signal: ctrl.signal,
        getLastEventId: () => lastSeenSeq,
        backoff: pipelineStreamBackoff,
        isTerminal: (ev) => TERMINAL_PIPELINE_EVENTS.has(ev.event),
        onPhase: (phase) => {
          if (phase === 'live') hasOpened = true;
        },
        onEvent: (ev) => {
          if (ev.id !== undefined && ev.id > lastSeenSeq) lastSeenSeq = ev.id;
          if (!ev.data) return;
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(ev.data);
          } catch {
            return;
          }
          handleEvent(ev.event, data);
        },
      });

      void client.run().catch((err: unknown) => {
        if (cancelled) return;
        if ((err as { status?: number }).status === 404 && !hasOpened) return;
        console.warn('[pipeline] stream failed:', err);
      }).finally(() => {
        if (streamAbortRef.current === ctrl) streamAbortRef.current = null;
      });
    };

    openStreamRef.current = connect;

    // Probe once for a persisted execution. The /executions endpoint
    // falls through to the durable store when no in-memory executor
    // exists, so a non-empty result means the SSE will succeed.
    fetch(`${apiBaseUrl()}/api/coder/sessions/${sessionId}/pipelines/executions`)
      .then((r) => (r.ok ? r.json() : []))
      .then((execs: unknown) => {
        if (cancelled) return;
        if (Array.isArray(execs) && execs.length > 0) connect();
      })
      .catch(() => {
        // Best-effort probe — caller can still trigger via openStream().
      });

    return () => {
      cancelled = true;
      openStreamRef.current = () => {};
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
    };
  }, [sessionId]);

  return { pipelineRuntime: runtime, openStream, reset };
}
