import { useEffect, useRef, useState } from 'react';

/**
 * Tracks the backend sandbox state for a company session.
 *
 * Implementation: polls `GET /api/company/sessions/:id/sandbox` until the
 * sandbox reaches `ready` or `error`, then slows the poll down to a
 * heartbeat interval. We intentionally don't piggyback on the company SSE
 * stream — that hook is already doing a lot, and a dedicated poll keeps
 * the preview pane independent (e.g. easier to unmount without tearing
 * down the chat stream).
 *
 * Cadence:
 *   - 1s while `pending` / `provisioning` / `destroying`
 *   - 10s once `ready` / `error` / `destroyed` or sandbox is null
 *
 * Returns the last known snapshot plus a manual `refresh()` for the UI
 * when the user clicks the reload button.
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
  builder: { stack: 'react-ts' | 'vue-ts' } | null;
  sandbox:
    | {
        status: SandboxPollStatus;
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

const FAST_MS = 1_500;
const SLOW_MS = 10_000;
// `error` deliberately polls slow: the record is stable, the UI shows
// the message, and the user must click Retry to change anything.
const TERMINAL: SandboxPollStatus[] = ['ready', 'error', 'destroyed'];

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
  const bump = useRef(0);

  function refresh() {
    bump.current += 1;
    // Force an immediate refetch by triggering a state change via error reset.
    setError(null);
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
      /* the next poll will surface the new state anyway */
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
      /* swallow — next poll surfaces state */
    }
    refresh();
  }

  useEffect(() => {
    cancelled.current = false;
    if (sessionId === null) {
      setData(null);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let bumpSeen = bump.current;
    // Last time we fired the eager-provision POST. We throttle rather
    // than use a one-shot flag so a sandbox that disappears mid-session
    // (TTL reaper, server restart reaping orphans, crash) gets
    // re-provisioned automatically — the user doesn't have to refresh
    // the page to get their preview back.
    let lastKickAt = 0;
    const KICK_THROTTLE_MS = 5_000;

    async function tick() {
      if (cancelled.current) return;
      try {
        // `credentials: 'include'` so the browser saves the signed
        // preview cookie the server returns. Same-origin would already
        // persist cookies, but we're explicit here to avoid silent
        // breakage if the dashboard is ever served from a CDN subdomain.
        const res = await fetch(`/api/company/sessions/${sessionId}/sandbox`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as SandboxSnapshot;
        if (cancelled.current) return;
        setData(json);
        setError(null);
        // Re-provision / auto-resume trigger:
        //   - Session is in builder mode AND
        //   - Either no sandbox exists OR the existing one is paused
        //     by the idle TTL, AND
        //   - We haven't fired a POST in the last 5s.
        //
        // A POST in the paused case hits the same `provision()` which
        // short-circuits into `resumeSandbox()` → `podman start` +
        // relaunch Vite (~5s). For a fresh session, same call does
        // full provisioning. One idempotent endpoint, both cases.
        const needsKick =
          json.builder &&
          (!json.sandbox || json.sandbox.status === 'paused');
        if (needsKick && Date.now() - lastKickAt >= KICK_THROTTLE_MS) {
          lastKickAt = Date.now();
          void fetch(`/api/company/sessions/${sessionId}/sandbox`, {
            method: 'POST',
            credentials: 'include',
          }).catch(() => {
            // Transient failure — let the next tick re-trigger after
            // the throttle window. We deliberately don't log: the
            // user will see the spinner + "Waiting for sandbox…" and
            // the next attempt will either succeed or surface an error.
          });
        }
      } catch (e) {
        if (cancelled.current) return;
        setError(e instanceof Error ? e.message : String(e));
      }
      if (cancelled.current) return;
      const status = data?.sandbox?.status;
      const terminal = !data?.builder || (status && TERMINAL.includes(status));
      timer = setTimeout(tick, terminal ? SLOW_MS : FAST_MS);
    }

    // Kick off. If `refresh` was called recently, reset the bump cursor
    // so the next tick runs immediately regardless of current timer.
    if (bump.current !== bumpSeen) {
      bumpSeen = bump.current;
    }
    tick();

    return () => {
      cancelled.current = true;
      if (timer) clearTimeout(timer);
    };
    // Intentionally NOT depending on `data` — that would restart the
    // polling loop on every tick. We re-evaluate the interval inside
    // `tick()` using the captured `data` snapshot, which is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, error === null ? 0 : 1]);

  return { data, error, refresh, retry, restartDev };
}
