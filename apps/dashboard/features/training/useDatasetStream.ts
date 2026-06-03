/**
 * useDatasetStream — drives one dataset-generation run: kicks off the SSE
 * POST, accumulates live progress (accepted/total/cost), and exposes a
 * cancel. The component renders from `state`; completion fires `onDone` so
 * the caller can refresh its dataset list.
 */
import { useCallback, useRef, useState } from 'react';
import type { StartDatasetInput } from '@mcp/api-bus';
import { startDatasetStream } from './api.js';

export interface DatasetRunState {
  running: boolean;
  index: number;
  total: number;
  accepted: number;
  costUsd: number;
  lastVerdict: 'pass' | 'fail' | null;
  error: string | null;
  /** Server-sent status message from the 'done' event (e.g. 'no_seeds'). */
  note: string | null;
  /** Transient status line (e.g. sandbox provisioning). */
  status: string | null;
}

const IDLE: DatasetRunState = {
  running: false, index: 0, total: 0, accepted: 0, costUsd: 0,
  lastVerdict: null, error: null, note: null, status: null,
};

export function useDatasetStream(onDone?: () => void): {
  state: DatasetRunState;
  start: (input: StartDatasetInput) => void;
  cancel: () => void;
} {
  const [state, setState] = useState<DatasetRunState>(IDLE);
  const ctrl = useRef<AbortController | null>(null);

  const start = useCallback((input: StartDatasetInput) => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    setState({ ...IDLE, running: true, total: input.count });

    void startDatasetStream(
      input,
      (event, data) => {
        setState((prev) => {
          if (event === 'status') return { ...prev, status: data.message ?? null };
          if (event === 'start') return { ...prev, total: data.total ?? prev.total };
          if (event === 'example') {
            return {
              ...prev,
              index: (data.index ?? prev.index) + 1,
              total: data.total ?? prev.total,
              accepted: data.accepted ?? prev.accepted,
              costUsd: data.costUsd ?? prev.costUsd,
              lastVerdict: data.verdict ?? prev.lastVerdict,
              status: null,
            };
          }
          if (event === 'done') return { ...prev, note: data.message ?? null };
          if (event === 'error') return { ...prev, running: false, error: data.message ?? 'error' };
          return prev;
        });
      },
      ac.signal,
    )
      .then(() => {
        setState((prev) => ({ ...prev, running: false }));
        onDone?.();
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) { setState((prev) => ({ ...prev, running: false })); return; }
        setState((prev) => ({ ...prev, running: false, error: e instanceof Error ? e.message : String(e) }));
      });
  }, [onDone]);

  const cancel = useCallback(() => {
    ctrl.current?.abort();
    setState((prev) => ({ ...prev, running: false }));
  }, []);

  return { state, start, cancel };
}
