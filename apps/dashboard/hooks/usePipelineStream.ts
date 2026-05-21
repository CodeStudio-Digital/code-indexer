import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PipelineNodeRuntimeStatus,
  PipelineRuntimeState,
} from './agent-stream/types.js';

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
export function usePipelineStream(sessionId: number | null): {
  pipelineRuntime: PipelineRuntimeState | null;
  openStream: () => void;
  reset: () => void;
} {
  const [runtime, setRuntime] = useState<PipelineRuntimeState | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const openStreamRef = useRef<() => void>(() => {});

  const reset = useCallback(() => setRuntime(null), []);
  const openStream = useCallback(() => openStreamRef.current(), []);

  useEffect(() => {
    setRuntime(null);
    openStreamRef.current = () => {};
    if (sessionId == null) return;

    let cancelled = false;
    let backoffMs = 2000;
    let hasOpened = false;

    const connect = () => {
      if (cancelled) return;
      if (sourceRef.current) return;
      const url = `/api/coder/sessions/${sessionId}/pipelines/stream`;
      const src = new EventSource(url);
      sourceRef.current = src;

      const handle = (
        eventName: string,
        handler: (data: Record<string, unknown>) => void,
      ) => {
        src.addEventListener(eventName, (ev: MessageEvent) => {
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(ev.data);
          } catch {
            return;
          }
          handler(data);
        });
      };

      handle('pipeline_started', (d) => {
        const data = d as { executionId: number; pipelineId: number; startNodeId?: string };
        setRuntime({
          executionId: data.executionId,
          pipelineId: data.pipelineId,
          status: 'running',
          currentNodeId: data.startNodeId ?? null,
          nodes: data.startNodeId ? { [data.startNodeId]: { status: 'pending' } } : {},
          error: null,
        });
      });

      handle('pipeline_node_started', (d) => {
        const data = d as {
          executionId: number;
          nodeId: string;
          nodeLabel?: string;
          kind?: 'agent' | 'validate';
        };
        setRuntime((cur) => {
          if (!cur || cur.executionId !== data.executionId) return cur;
          return {
            ...cur,
            currentNodeId: data.nodeId,
            nodes: {
              ...cur.nodes,
              [data.nodeId]: {
                ...(cur.nodes[data.nodeId] ?? {}),
                status: 'running' as PipelineNodeRuntimeStatus,
                label: data.nodeLabel ?? cur.nodes[data.nodeId]?.label,
                kind: data.kind ?? cur.nodes[data.nodeId]?.kind,
              },
            },
          };
        });
      });

      handle('pipeline_node_completed', (d) => {
        const data = d as {
          executionId: number;
          nodeId: string;
          outcome?: string | null;
          verdict?: 'pass' | 'fail' | 'review' | null;
          outputPreview?: string;
        };
        setRuntime((cur) => {
          if (!cur || cur.executionId !== data.executionId) return cur;
          return {
            ...cur,
            nodes: {
              ...cur.nodes,
              [data.nodeId]: {
                ...(cur.nodes[data.nodeId] ?? {}),
                status: 'completed',
                verdict: data.verdict ?? null,
                outcome: data.outcome ?? null,
                outputPreview: data.outputPreview,
              },
            },
          };
        });
      });

      handle('pipeline_node_failed', (d) => {
        const data = d as { executionId: number; nodeId: string; error?: string };
        setRuntime((cur) => {
          if (!cur || cur.executionId !== data.executionId) return cur;
          return {
            ...cur,
            nodes: {
              ...cur.nodes,
              [data.nodeId]: {
                ...(cur.nodes[data.nodeId] ?? {}),
                status: 'failed',
                error: data.error,
              },
            },
          };
        });
      });

      handle('pipeline_paused', (d) => {
        const data = d as {
          executionId: number;
          nodeId?: string | null;
          awaitingConfirmation?: boolean;
        };
        setRuntime((cur) => {
          if (!cur || cur.executionId !== data.executionId) return cur;
          return {
            ...cur,
            status: 'paused',
            currentNodeId: data.nodeId ?? cur.currentNodeId,
            awaitingConfirmation: !!data.awaitingConfirmation,
          };
        });
      });

      handle('pipeline_resumed', (d) => {
        const data = d as { executionId: number; nodeId?: string };
        setRuntime((cur) => {
          if (!cur || cur.executionId !== data.executionId) return cur;
          return {
            ...cur,
            status: 'running',
            currentNodeId: data.nodeId ?? cur.currentNodeId,
            awaitingConfirmation: false,
          };
        });
      });

      handle('pipeline_completed', (d) => {
        const data = d as { executionId: number };
        setRuntime((cur) => {
          if (!cur || cur.executionId !== data.executionId) return cur;
          return { ...cur, status: 'completed', currentNodeId: null };
        });
      });

      handle('pipeline_aborted', (d) => {
        const data = d as { executionId: number; reason?: string | null };
        setRuntime((cur) => {
          if (!cur || cur.executionId !== data.executionId) return cur;
          return {
            ...cur,
            status: 'aborted',
            currentNodeId: null,
            error: data.reason ?? null,
          };
        });
      });

      handle('pipeline_failed', (d) => {
        const data = d as { executionId: number; error?: string };
        setRuntime((cur) => {
          if (!cur || cur.executionId !== data.executionId) return cur;
          return {
            ...cur,
            status: 'failed',
            currentNodeId: null,
            error: data.error ?? null,
          };
        });
      });

      src.onerror = () => {
        src.close();
        sourceRef.current = null;
        if (cancelled) return;
        // Reconnect only when the stream actually opened at least once.
        // The "never opened" case is the 404 from a session with no
        // executor yet — bail out and wait for a fresh `openStream()`
        // (called by the caller after a successful pipeline start)
        // instead of spamming the Network tab with retries.
        if (!hasOpened) return;
        const next = Math.min(backoffMs, 30_000);
        backoffMs = Math.min(backoffMs * 1.5, 30_000);
        setTimeout(connect, next);
      };

      src.onopen = () => {
        hasOpened = true;
        backoffMs = 2000;
      };
    };

    openStreamRef.current = connect;

    // Probe once for a persisted execution. The /executions endpoint
    // falls through to the durable store when no in-memory executor
    // exists, so a non-empty result means the SSE will succeed.
    fetch(`/api/coder/sessions/${sessionId}/pipelines/executions`)
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
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [sessionId]);

  return { pipelineRuntime: runtime, openStream, reset };
}
