import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { SendResponse } from './types.js';
import { comparisonBaseline, type ComparisonResponse } from './response/compare-responses.js';

interface RequestRun {
  response?: SendResponse;
  previous?: ComparisonResponse;
  sending: boolean;
  cancelled: boolean;
  error?: string;
}

export function useRequestRuns(openTabIds: number[]) {
  const [runs, setRuns] = useState<Record<number, RequestRun>>({});
  const pending = useRef(new Map<number, AbortController>()).current;
  const open = useRef(new Set<number>());

  useLayoutEffect(() => {
    open.current = new Set(openTabIds);
    for (const [id, controller] of pending) {
      if (open.current.has(id)) continue;
      pending.delete(id);
      controller.abort();
    }
    setRuns(current => {
      const closed = Object.keys(current).map(Number).filter(id => !open.current.has(id));
      if (!closed.length) return current;
      const next = { ...current };
      for (const id of closed) delete next[id];
      return next;
    });
  }, [openTabIds, pending]);

  useLayoutEffect(() => () => {
    open.current.clear();
    for (const controller of pending.values()) controller.abort();
    pending.clear();
  }, [pending]);

  const cancel = useCallback((id: number) => {
    const controller = pending.get(id);
    if (!controller) return;
    pending.delete(id);
    controller.abort();
    setRuns(s => ({ ...s, [id]: { ...s[id], sending: false, cancelled: true } }));
  }, [pending]);

  const run = useCallback(async (id: number, execute: (signal: AbortSignal) => Promise<SendResponse>) => {
    if (!open.current.has(id) || pending.has(id)) return;
    const controller = new AbortController();
    pending.set(id, controller);
    setRuns(s => ({ ...s, [id]: { ...s[id], sending: true, cancelled: false, error: undefined } }));
    try {
      const response = await execute(controller.signal);
      if (pending.get(id) !== controller) return;
      setRuns(s => {
        const last = s[id]?.response;
        return { ...s, [id]: { previous: last && comparisonBaseline(last), response, sending: false, cancelled: false } };
      });
      return response;
    } catch (e) {
      if (pending.get(id) !== controller) return;
      const error = e instanceof Error ? e.message : String(e);
      setRuns(s => ({ ...s, [id]: { ...s[id], error, sending: false, cancelled: false } }));
    } finally {
      if (pending.get(id) === controller) pending.delete(id);
    }
  }, [pending]);
  const saveAs = useCallback((draft: number, saved: number) => setRuns(s => {
    if (!s[draft] || s[draft].sending) return s;
    const next = { ...s, [saved]: s[draft] };
    delete next[draft];
    return next;
  }), []);
  return { runs, run, cancel, saveAs };
}
