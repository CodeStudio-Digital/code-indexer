import { useCallback, useRef, useState } from 'react';
import type { MachineSetupEvent } from '@mcp/api-bus';
import { apiStream } from '../../lib/api-client.js';

type MachineStatus = 'idle' | 'running' | 'done' | 'error';
interface PhaseInfo { phase: string; label: string }
interface MachineError { message: string; stderrTail?: string }

const LOG_CAP = 20_000;

/**
 * Drives `system.podmanMachineSetupStream` over the in-process IPC stream
 * (not SSE — there's no Hono route for it). Completes on the terminal
 * `done`/`error` frame; `cancel()` returns the iterator (aborts the host child).
 */
export function useMachineSetupStream() {
  const [status, setStatus] = useState<MachineStatus>('idle');
  const [phase, setPhase] = useState<PhaseInfo | null>(null);
  const [log, setLog] = useState('');
  const [error, setError] = useState<MachineError | null>(null);
  const iterRef = useRef<AsyncIterator<MachineSetupEvent> | null>(null);

  const reset = useCallback(() => {
    setStatus('idle');
    setPhase(null);
    setLog('');
    setError(null);
  }, []);

  const cancel = useCallback(() => {
    void iterRef.current?.return?.(undefined);
    iterRef.current = null;
    reset();
  }, [reset]);

  const start = useCallback(async () => {
    setStatus('running');
    setPhase(null);
    setLog('');
    setError(null);
    const iter = apiStream<MachineSetupEvent>('system.podmanMachineSetupStream')[Symbol.asyncIterator]();
    iterRef.current = iter;
    try {
      for (let r = await iter.next(); !r.done; r = await iter.next()) {
        const ev = r.value;
        if (ev.event === 'phase') setPhase(ev.data);
        else if (ev.event === 'log') setLog((p) => (p + ev.data.chunk).slice(-LOG_CAP));
        else if (ev.event === 'done') setStatus('done');
        else if (ev.event === 'error') {
          setError(ev.data);
          setStatus('error');
        }
      }
      setStatus((s) => (s === 'error' ? s : 'done'));
    } catch (err) {
      setError((prev) => prev ?? { message: err instanceof Error ? err.message : String(err) });
      setStatus('error');
    } finally {
      iterRef.current = null;
    }
  }, []);

  return { status, phase, log, error, start, cancel, reset };
}
