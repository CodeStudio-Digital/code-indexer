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
 * The hook is a no-op when `sessionId` is null. When the endpoint
 * returns 404 (no executor for this session yet), the hook silently
 * waits — a fresh `POST /pipelines/:pid/start` will spin one up; a
 * subsequent open of the stream will then succeed. The browser's
 * built-in EventSource handles reconnection automatically.
 */
export function usePipelineStream(sessionId: number | null): {
  pipelineRuntime: PipelineRuntimeState | null;
  reset: () => void;
} {
  const [runtime, setRuntime] = useState<PipelineRuntimeState | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const reset = useCallback(() => setRuntime(null), []);

  useEffect(() => {
    setRuntime(null);
    if (sessionId == null) return;

    let cancelled = false;
    let backoffMs = 2000;

    const connect = () => {
      if (cancelled) return;
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
        // 404 (no executor yet) and disconnects both land here. EventSource
        // auto-reconnects, but if the endpoint stays 404 the browser keeps
        // reconnecting silently — which is fine for our case (will succeed
        // once the user starts a pipeline).
        src.close();
        sourceRef.current = null;
        if (cancelled) return;
        const next = Math.min(backoffMs, 30_000);
        backoffMs = Math.min(backoffMs * 1.5, 30_000);
        setTimeout(connect, next);
      };

      // Reset backoff on successful open.
      src.onopen = () => {
        backoffMs = 2000;
      };
    };

    connect();

    return () => {
      cancelled = true;
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [sessionId]);

  return { pipelineRuntime: runtime, reset };
}
