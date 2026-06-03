import { useEffect, useRef, useState } from 'react';
import {
  selectSandbox,
  selectStream,
  useCompanyStore,
} from '../../state/company/index.js';

/**
 * Tracks the backend sandbox state for a company session.
 *
 * **Update model (post-P14b — no more polling):**
 *   - Initial fetch on mount + on `sessionId` change.
 *   - Refetch ONLY when the backend publishes a sandbox lifecycle event
 *     (`sandbox.status_changed`, `sandbox.ready`, `sandbox.paused`,
 *     `sandbox.resumed`, `sandbox.error`, `sandbox.destroyed`,
 *     `sandbox.provisioning`, `sandbox.step`). `useCompanyStream` routes
 *     those events into `sandboxSlice.statusSeq`; this hook subscribes
 *     to that counter and refetches on each bump.
 *   - **Polling fallback only when the SSE stream is disconnected** (e.g.
 *     dormant orchestrator, browser came back from sleep). 10 s slow
 *     heartbeat — enough to recover, light enough to ignore.
 *
 * The legacy 1.5–10 s setInterval poller is gone. Browsers running a
 * single dashboard tab with the company view open should now make
 * ~0–1 sandbox requests per minute under normal conditions, vs
 * ~30–40 before.
 */

export type SandboxPollStatus =
  | 'pending'
  | 'provisioning'
  | 'ready'
  | 'paused'
  | 'error'
  | 'destroying'
  | 'destroyed';

export type SandboxStepLabel =
  | 'queued'
  | 'creating-container'
  | 'scaffolding'
  | 'installing-deps'
  | 'starting-dev-server'
  | 'ready'
  | 'error';

export interface SandboxLogLine {
  at: number;
  level: 'info' | 'error';
  text: string;
}

export interface SandboxSnapshot {
  builder: { stack: 'react-ts' | 'vue-ts'; studio?: boolean } | null;
  sandbox:
    | {
        status: SandboxPollStatus;
        runtimePaused?: boolean;
        step: SandboxStepLabel;
        previewUrl: string;
        stack: 'react-ts' | 'vue-ts';
        error: string | null;
        hostPort: number;
        createdAt: number;
        recentLogs: SandboxLogLine[];
        /** Populated when the manager has a container id for this session.
         *  Used by the UI to decide whether the "View logs" button is
         *  actionable. */
        containerId?: string;
        /** Resolved CPU/memory/pids the container was actually created with
         *  (session override merged with env defaults). */
        limits: { memory: string; cpus: string; pids: number };
      }
    | null;
}

/**
 * Slow heartbeat used ONLY when the SSE stream is disconnected.
 * 10 s is the same value the legacy poller used in its terminal
 * state, so behavior degrades gracefully if the user keeps the tab
 * open while their orchestrator is dormant.
 */
const DISCONNECTED_HEARTBEAT_MS = 10_000;

export function useSandboxStatus(sessionId: number | null): {
  data: SandboxSnapshot | null;
  error: string | null;
  refresh: () => void;
  retry: () => Promise<void>;
  restartDev: () => Promise<void>;
} {
  const [data, setData] = useState<SandboxSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  // Local manual-refresh counter so callers' `refresh()` triggers a
  // refetch without depending on the SSE seq.
  const [manualSeq, setManualSeq] = useState(0);

  // Subscribe to the event-driven sandbox status counter and the
  // connection state — connected sessions skip the heartbeat.
  const statusSeq = useCompanyStore((s) =>
    sessionId == null ? 0 : selectSandbox(s, sessionId).statusSeq,
  );
  const connected = useCompanyStore((s) =>
    sessionId == null ? false : selectStream(s, sessionId).connected,
  );

  function refresh(): void {
    setManualSeq((n) => n + 1);
  }

  /**
   * Explicit retry: hits `POST /sandbox?retry=1`, which tells the manager
   * to tear down any existing `error` record before provisioning. Used by
   * the PreviewPanel's Retry button when scaffolding failed.
   */
  async function retry(): Promise<void> {
    if (sessionId === null) return;
    try {
      await fetch(`/api/company/sessions/${sessionId}/sandbox?retry=1`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      /* the next sandbox event will surface the new state */
    }
    refresh();
  }

  /**
   * Relaunch the dev server inside the existing container WITHOUT
   * destroying the workdir. Recovers from the common failure where
   * the agent overwrote `vite.config.ts` and Vite stopped binding
   * the expected interface — a full retry would throw away all the
   * files the agent wrote.
   */
  async function restartDev(): Promise<void> {
    if (sessionId === null) return;
    try {
      await fetch(`/api/company/sessions/${sessionId}/sandbox/restart-dev`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      /* swallow — next event surfaces state */
    }
    refresh();
  }

  // Single-fetch effect — runs on sessionId change, manual refresh,
  // and any incoming sandbox status event.
  useEffect(() => {
    cancelled.current = false;
    if (sessionId === null) {
      setData(null);
      return;
    }
    async function fetchOnce(): Promise<void> {
      try {
        const res = await fetch(`/api/company/sessions/${sessionId}/sandbox`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as SandboxSnapshot;
        if (cancelled.current) return;
        setData(json);
        setError(null);
      } catch (e) {
        if (cancelled.current) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    void fetchOnce();
    return () => {
      cancelled.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, statusSeq, manualSeq]);

  // Disconnected-only heartbeat. When the orchestrator is dormant the
  // SSE stream is closed and event-driven refresh stops — we tick once
  // every 10 s as a recovery path. As soon as `connected === true`,
  // the heartbeat clears itself and event-driven refresh takes over.
  useEffect(() => {
    if (sessionId === null || connected) return;
    const id = setInterval(() => {
      setManualSeq((n) => n + 1);
    }, DISCONNECTED_HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [sessionId, connected]);

  return { data, error, refresh, retry, restartDev };
}
