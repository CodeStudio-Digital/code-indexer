/**
 * Consumes the host-scaffold SSE endpoint (`POST /api/projects/scaffold/
 * stream`) via the shared `ReconnectingSSEClient` — the same client the
 * coder chat uses. Crucially it completes on the terminal event (`done`/
 * `error`) instead of waiting for the connection to EOF: in Electron the
 * `mcp://` stream (and the Vite dev proxy in browser mode) don't always
 * deliver a clean end-of-stream, which would otherwise hang the UI on
 * "running" forever even though the scaffold already finished server-side.
 *
 * Reconnect is disabled (`maxAttempts: 0`): a scaffold is NOT replayable —
 * a re-POST would re-run the whole `npm create` from scratch.
 */
import { useCallback, useRef, useState } from 'react';
import { ReconnectingSSEClient } from '@mcp/shared/sse/ReconnectingSSEClient.js';
import { ExponentialBackoff } from '@mcp/shared/sse/BackoffStrategy.js';
import { apiBaseUrl } from '../../../lib/api-client.js';
import type { TemplateId } from './templates.js';

export interface ScaffoldStartBody {
  template: TemplateId;
  name: string;
  description?: string;
  repoUrl?: string;
  gitInit?: boolean;
  /** Builder mode (react-vite only) — Tailwind+shadcn+element selection. */
  builder?: boolean;
}

export interface CreatedProject {
  id: number;
  name: string;
  root_path: string;
}

export type ScaffoldStatus = 'idle' | 'running' | 'done' | 'error';

interface PhaseInfo {
  phase: string;
  label: string;
}

const LOG_CAP = 20_000;

export function useScaffoldStream() {
  const [status, setStatus] = useState<ScaffoldStatus>('idle');
  const [phase, setPhase] = useState<PhaseInfo | null>(null);
  const [log, setLog] = useState('');
  const [project, setProject] = useState<CreatedProject | null>(null);
  const [error, setError] = useState<{ message: string; stderrTail?: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setStatus('idle');
    setPhase(null);
    setLog('');
    setProject(null);
    setError(null);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    reset();
  }, [reset]);

  const start = useCallback(async (body: ScaffoldStartBody) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setStatus('running');
    setPhase(null);
    setLog('');
    setProject(null);
    setError(null);

    const client = new ReconnectingSSEClient({
      url: `${apiBaseUrl()}/api/projects/scaffold/stream`,
      method: 'POST',
      body,
      signal: ac.signal,
      // No reconnect — re-POSTing would re-scaffold from scratch.
      backoff: new ExponentialBackoff({ maxAttempts: 0 }),
      isTerminal: (ev) => ev.event === 'done' || ev.event === 'error',
      onEvent: (ev) => {
        if (!ev.data) return;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (ev.event === 'phase') setPhase(data as unknown as PhaseInfo);
        else if (ev.event === 'start') setPhase({ phase: 'start', label: 'Starting' });
        else if (ev.event === 'log') setLog((prev) => (prev + String(data.chunk ?? '')).slice(-LOG_CAP));
        else if (ev.event === 'done') {
          setProject(data.project as unknown as CreatedProject);
          setStatus('done');
        } else if (ev.event === 'error') {
          setError(data as unknown as { message: string; stderrTail?: string });
          setStatus('error');
        }
      },
    });

    try {
      await client.run();
    } catch (err) {
      if (ac.signal.aborted) return; // user cancelled — keep UI quiet
      // Only surface a transport error if we didn't already get a terminal frame.
      setError((prev) => prev ?? { message: err instanceof Error ? err.message : String(err) });
      setStatus((s) => (s === 'done' ? s : 'error'));
    }
  }, []);

  return { status, phase, log, project, error, start, cancel, reset };
}
