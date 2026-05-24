/**
 * React hook that consumes a streaming RPC call from `apiStream()`.
 * Same surface in Electron (MessagePort transport) and browser dev
 * (SSE fallback when wired) — callers only see `{events, done, error,
 * cancel}`. The underlying transport is decided by `api-client.apiStream`.
 *
 * Usage:
 *
 *   const { events, done, error, cancel } = useApiStream(
 *     'projects.indexStream',
 *     start ? { id: projectId, provider: 'anthropic' } : undefined,
 *   );
 *   // events is an append-only list of frames; renders re-trigger when
 *   // each frame lands. cancel() aborts the iterator.
 *
 * Passing `undefined` as input pauses the hook — useful for "start only
 * when a button is clicked" flows. Switching from undefined to a real
 * input begins a new stream; switching back to undefined cancels.
 */

import { useEffect, useRef, useState } from 'react';
import { apiStream } from '../lib/api-client.js';

interface StreamState<T> {
  events: T[];
  done: boolean;
  error: string | null;
  /** Force-cancel the current stream. Safe to call multiple times. */
  cancel: () => void;
}

export function useApiStream<T>(path: string, input: unknown | undefined): StreamState<T> {
  const [events, setEvents] = useState<T[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<() => void>(() => undefined);

  // Serialize input for the dependency check. JSON.stringify is fine here
  // because inputs are RPC payloads (plain data); a Date or function would
  // be a bug in the caller.
  const inputKey = input === undefined ? null : JSON.stringify(input);

  useEffect(() => {
    if (input === undefined) {
      setEvents([]);
      setDone(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setEvents([]);
    setDone(false);
    setError(null);

    const iterable = apiStream<T>(path, input);
    const iterator = iterable[Symbol.asyncIterator]();
    // Expose a cancel that calls return() on the iterator — both transports
    // wire that to closing the MessagePort / aborting the EventSource.
    cancelRef.current = () => {
      cancelled = true;
      void iterator.return?.();
    };

    void (async () => {
      try {
        while (true) {
          const { value, done: d } = await iterator.next();
          if (cancelled) return;
          if (d) {
            setDone(true);
            return;
          }
          setEvents((prev) => [...prev, value]);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setDone(true);
      }
    })();

    return () => {
      cancelled = true;
      void iterator.return?.();
    };
  }, [path, inputKey]);

  return { events, done, error, cancel: () => cancelRef.current() };
}
