/**
 * Client for `/api/admin/supervisor/*` (Sprint 4 Phase 3.3).
 *
 * Mirrors the response shapes from
 * `apps/http-api/server/routes/admin/supervisor.ts`. Anything that
 * returns a snake_case field from the supervisor is mapped here so the
 * UI consumes camelCase consistently.
 *
 * **Transport**: every call routes through `apiBaseUrl()` so Electron
 * dispatches via the `mcp://app` custom protocol (no socket, no
 * loopback — the Hono HTTP listener stays off by default in dev with
 * MCP_DEV_HTTP=0). In browser dev (MCP_DEV_HTTP=1), `apiBaseUrl()`
 * returns empty and relative URLs route through the Vite proxy to
 * the standalone Hono process at :3333.
 */

import { apiBaseUrl } from '../../lib/api-client.js';

export type SupervisionState =
  | 'BOOTING'
  | 'RUNNING_TURN'
  | 'AWAITING_PROVIDER'
  | 'AWAITING_TOOL'
  | 'AWAITING_MASTER_APPROVAL'
  | 'AWAITING_INBOX_ANSWER'
  | 'IDLE'
  | 'RESURRECTING'
  | 'QUARANTINED'
  | 'TERMINAL'
  | 'STUCK_BOOT'
  | 'STUCK_TURN'
  | 'STUCK_PROVIDER'
  | 'STUCK_TOOL'
  | 'STUCK_AWAITING_MASTER'
  | 'INBOX_EXPIRED'
  | 'FAILED_BOOT'
  | 'FAILED_RESURRECT';

export interface BreakerStatusSnapshot {
  agents: Array<{ agentRunId: number; recentAttempts: number; tripped: boolean }>;
  roles: Array<{ role: string; recentFailures: number; quarantinedUntilMs: number | null }>;
  globalIncidentsInWindow: number;
  readOnlyUntilMs: number | null;
}

export interface SupervisorStatus {
  isRunning: boolean;
  trackedCount: number;
  byState: Record<string, number>;
  stuckCount: number;
  totalIncidents: number;
  lastTickAtMs: number | null;
  tickCount: number;
  breakers: BreakerStatusSnapshot;
}

export interface SupervisorSessionStatus {
  sessionId: number;
  status: SupervisorStatus | null;
}

export interface StatusResponse {
  enabled: boolean;
  sessions: SupervisorSessionStatus[];
}

export interface IncidentRow {
  id: number;
  agentRunId: number | null;
  companySessionId: number | null;
  incidentKind: string;
  fromState: SupervisionState | null;
  attemptedToState: SupervisionState | null;
  detail: string;
  diagnosticJson?: string | null;
  recoveryAction?: string | null;
  recoveryOutcome?: 'success' | 'failed' | 'queued' | null;
  detectedAtMs: number;
  resolvedAtMs: number | null;
}

/** Envelope shape from the SSE `incident` event. */
export interface SupervisorIncidentEnvelope {
  sessionId: number;
  kind: string;
  agentRunId: number | null;
  fromState?: string;
  attemptedTo?: string;
  detail: string;
  detectedAtMs: number;
}

export async function fetchSupervisorStatus(): Promise<StatusResponse> {
  const r = await fetch(`${apiBaseUrl()}/api/admin/supervisor/status`);
  if (!r.ok) throw new Error(`status ${r.status}`);
  return (await r.json()) as StatusResponse;
}

export async function fetchSupervisorIncidents(
  sessionId: number,
  limit: number = 50,
): Promise<{ sessionId: number; incidents: IncidentRow[] }> {
  const r = await fetch(
    `${apiBaseUrl()}/api/admin/supervisor/incidents?sessionId=${sessionId}&limit=${limit}`,
  );
  if (!r.ok) throw new Error(`incidents ${r.status}`);
  return (await r.json()) as { sessionId: number; incidents: IncidentRow[] };
}

export async function releaseRoleQuarantine(
  sessionId: number,
  role: string,
): Promise<{ released: boolean; sessionId: number; role: string }> {
  const r = await fetch(`${apiBaseUrl()}/api/admin/supervisor/release-quarantine`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, role }),
  });
  if (!r.ok) throw new Error(`release-quarantine ${r.status}`);
  return (await r.json()) as { released: boolean; sessionId: number; role: string };
}

export async function releaseReadOnlyMode(
  sessionId: number,
): Promise<{ released: boolean; sessionId: number }> {
  const r = await fetch(`${apiBaseUrl()}/api/admin/supervisor/release-read-only`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!r.ok) throw new Error(`release-read-only ${r.status}`);
  return (await r.json()) as { released: boolean; sessionId: number };
}

/**
 * SSE-over-fetch helper. Native `EventSource` only supports http/https,
 * but Electron dispatches the dashboard's API through the `mcp://app`
 * custom protocol. We open a streaming fetch, parse the SSE wire
 * format ourselves, and invoke the callbacks. Returned function aborts
 * the underlying fetch + cleans up.
 *
 * Callbacks:
 *   - onConnected — fired when the server emits `event: connected` OR
 *     when the first chunk lands (whichever comes first)
 *   - onIncident — fired for every `event: incident` parsed
 *   - onError — fired on transport errors; caller decides reconnect policy
 *
 * The SSE parser is minimal but handles:
 *   - Multi-line `data:` accumulation
 *   - `event:` field selection (filters non-incident frames)
 *   - Ignored `id:` and `retry:` (we don't honor server-suggested retry)
 *   - Trailing `\n\n` framing
 */
export interface SupervisorStreamCallbacks {
  onConnected?: () => void;
  onIncident?: (env: SupervisorIncidentEnvelope) => void;
  onError?: (err: Error) => void;
}

export function openSupervisorStream(
  callbacks: SupervisorStreamCallbacks,
  options: { since?: number } = {},
): () => void {
  const ctrl = new AbortController();
  const url = new URL('/api/admin/supervisor/stream', apiBaseUrl() || window.location.origin);
  if (options.since != null) url.searchParams.set('since', String(options.since));

  void (async () => {
    try {
      const r = await fetch(url.toString(), {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) {
        throw new Error(`stream ${r.status}`);
      }
      callbacks.onConnected?.();
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      // SSE frames are separated by `\n\n`. Within a frame, lines are:
      //   event: <name>
      //   data: <payload>
      //   data: <continued>
      //   id: <ignored>
      while (!ctrl.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let frameEnd = buf.indexOf('\n\n');
        while (frameEnd !== -1) {
          const frame = buf.slice(0, frameEnd);
          buf = buf.slice(frameEnd + 2);
          let eventName = 'message';
          const dataLines: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (eventName === 'connected') {
            callbacks.onConnected?.();
          } else if (eventName === 'incident' && dataLines.length > 0) {
            try {
              const parsed = JSON.parse(dataLines.join('\n')) as SupervisorIncidentEnvelope;
              callbacks.onIncident?.(parsed);
            } catch {
              /* drop malformed */
            }
          }
          frameEnd = buf.indexOf('\n\n');
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return () => ctrl.abort();
}
