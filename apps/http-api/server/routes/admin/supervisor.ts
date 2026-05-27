/**
 * Admin endpoints for the AgentSupervisor (Sprint 4 Phase 3.1).
 *
 * Routes:
 *   GET  /api/admin/supervisor/status         — aggregated across all active sessions
 *   GET  /api/admin/supervisor/status/:sessionId — live status of one session
 *   GET  /api/admin/supervisor/incidents?sessionId=X&limit=N — persisted log
 *   POST /api/admin/supervisor/release-quarantine — body {sessionId, role}
 *   POST /api/admin/supervisor/release-read-only  — body {sessionId}
 *
 * Live status comes from the worker-local supervisor via `supervisor.rpc`
 * bridge. Persisted incidents come from `agent_supervision_incidents`
 * via a direct read — works even when the worker isn't running (idle/
 * evicted/process restarted), because incidents are persisted with the
 * supervisor's write-through pattern.
 *
 * Legacy in-process mode (`MCP_ORCHESTRATOR_WORKER !== '1'`): the
 * supervisor singleton lives in main; resolve via `getGlobalAgentSupervisor`.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  getGlobalAgentSupervisor,
  isStuckState,
  SqliteSupervisionPersistence,
  type AgentSupervisionRecord,
  type AgentSupervisor,
  type IncidentQueryRow,
  type SupervisorStatus,
} from '@mcp/company/services/supervisor/index.js';
import {
  workerOrchestratorEnabled,
  getWorkerOrchestratorPool,
  describeWorkerOrchestratorStatus,
} from '../../../sse/workerPoolSingleton.js';
import {
  recentSupervisorIncidents,
  subscribeToSupervisorIncidents,
  type SupervisorIncidentEnvelope,
} from '../../../sse/supervisor-incident-bus.js';
import { attachHeartbeat } from '../../../sse/SSEHeartbeat.js';

interface SupervisorAdminDeps {
  /** SQLite path — used to open a read-only handle for incident queries. */
  dbPath: string;
}

/**
 * Read incidents directly from DB. Works regardless of worker liveness
 * because the supervisor persists with write-through. Reuses a single
 * persistence handle across requests for prepared-statement caching.
 */
class IncidentReader {
  private handle: SqliteSupervisionPersistence | null = null;
  constructor(private readonly dbPath: string) {}
  list(sessionId: number, limit: number): IncidentQueryRow[] {
    if (!this.handle) {
      try {
        this.handle = new SqliteSupervisionPersistence(this.dbPath);
      } catch {
        return [];
      }
    }
    try {
      return this.handle.listRecentIncidents(sessionId, limit);
    } catch {
      return [];
    }
  }
}

/**
 * Build a per-session SupervisorStatus snapshot from a subset of records
 * that share the same `companySessionId`. Used by the legacy-mode status
 * response so the dashboard's per-session filter (matches `sessionId`)
 * sees the real session id instead of a fake 0.
 *
 * Breakers stay global (process-wide) — per-session breaker split is
 * future work. Aggregate counts (trackedCount, byState, stuckCount,
 * totalIncidents) are computed from the slice; ticks + lastTickAtMs +
 * isRunning come from the global state (they're not per-session
 * concepts).
 */
function buildPerSessionStatus(
  sup: AgentSupervisor,
  records: ReadonlyArray<AgentSupervisionRecord>,
): SupervisorStatus {
  const byState: Record<string, number> = {};
  let stuck = 0;
  let totalIncidents = 0;
  for (const r of records) {
    byState[r.state] = (byState[r.state] ?? 0) + 1;
    if (isStuckState(r.state)) stuck++;
    totalIncidents += r.incidentCount;
  }
  const global = sup.getStatus();
  return {
    isRunning: global.isRunning,
    trackedCount: records.length,
    byState,
    stuckCount: stuck,
    totalIncidents,
    lastTickAtMs: global.lastTickAtMs,
    tickCount: global.tickCount,
    breakers: global.breakers,
  };
}

export function mountSupervisorAdminRoutes(app: Hono, deps: SupervisorAdminDeps): void {
  const incidentReader = new IncidentReader(deps.dbPath);

  // GET /status — aggregated across all active workers
  app.get('/api/admin/supervisor/status', async (c) => {
    if (!workerOrchestratorEnabled()) {
      const sup = getGlobalAgentSupervisor();
      const workerReason = describeWorkerOrchestratorStatus().reason;
      if (!sup) {
        return c.json({
          enabled: false,
          sessions: [],
          reason: workerReason ?? 'supervisor disabled',
        });
      }
      // Group tracker records by companySessionId so the per-session
      // SupervisorPanel filter matches against the real id (the legacy
      // path used to emit sessionId=0 which the rail filter dropped).
      const records = sup.listRecords();
      const bySession = new Map<number, AgentSupervisionRecord[]>();
      for (const r of records) {
        const list = bySession.get(r.companySessionId) ?? [];
        list.push(r);
        bySession.set(r.companySessionId, list);
      }
      const sessions = Array.from(bySession.entries()).map(([sessionId, list]) => ({
        sessionId,
        status: buildPerSessionStatus(sup, list),
      }));
      return c.json({
        enabled: true,
        mode: 'legacy',
        sessions,
        reason: workerReason,
      });
    }
    let pool;
    try {
      pool = getWorkerOrchestratorPool();
    } catch {
      return c.json({ enabled: true, mode: 'worker', sessions: [], reason: 'pool not init' });
    }
    const ids = pool.activeSessionIds();
    const results = await Promise.allSettled(
      ids.map(async (id) => ({
        sessionId: id,
        status: await pool.supervisorRpc(id, 'getStatus'),
      })),
    );
    const sessions = results
      .filter(
        (r): r is PromiseFulfilledResult<{ sessionId: number; status: unknown }> =>
          r.status === 'fulfilled',
      )
      .map((r) => r.value)
      .filter((s) => s.status !== null);
    return c.json({ enabled: true, mode: 'worker', sessions });
  });

  // GET /status/:sessionId — single session
  app.get('/api/admin/supervisor/status/:sessionId', async (c) => {
    const sessionId = Number(c.req.param('sessionId'));
    if (!Number.isFinite(sessionId)) return c.json({ error: 'invalid sessionId' }, 400);
    if (workerOrchestratorEnabled()) {
      const status = await pumpSupervisorRpc(sessionId, 'getStatus');
      if (status === null) return c.json({ error: 'session not active' }, 404);
      return c.json({ sessionId, status });
    }
    const sup = getGlobalAgentSupervisor();
    if (!sup) return c.json({ error: 'supervisor disabled' }, 404);
    return c.json({ sessionId, status: sup.getStatus() });
  });

  // GET /incidents?sessionId=X&limit=N — DB-backed, survives worker eviction
  app.get('/api/admin/supervisor/incidents', (c) => {
    const sessionId = Number(c.req.query('sessionId'));
    const limit = Math.min(500, Number(c.req.query('limit') ?? 50));
    if (!Number.isFinite(sessionId)) return c.json({ error: 'sessionId required' }, 400);
    if (!Number.isFinite(limit) || limit < 1) return c.json({ error: 'invalid limit' }, 400);
    const incidents = incidentReader.list(sessionId, limit);
    return c.json({ sessionId, incidents });
  });

  // POST /release-quarantine — body { sessionId, role }
  app.post('/api/admin/supervisor/release-quarantine', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { sessionId?: number; role?: string }
      | null;
    if (!body || typeof body.sessionId !== 'number' || typeof body.role !== 'string') {
      return c.json({ error: 'body requires {sessionId:number, role:string}' }, 400);
    }
    const released = await pumpSupervisorRpc<boolean>(body.sessionId, 'releaseRoleQuarantine', [
      body.role,
    ]);
    if (released === null) return c.json({ error: 'session not active' }, 404);
    return c.json({ sessionId: body.sessionId, role: body.role, released });
  });

  // POST /release-read-only — body { sessionId }
  app.post('/api/admin/supervisor/release-read-only', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { sessionId?: number } | null;
    if (!body || typeof body.sessionId !== 'number') {
      return c.json({ error: 'body requires {sessionId:number}' }, 400);
    }
    const released = await pumpSupervisorRpc<boolean>(body.sessionId, 'releaseReadOnlyMode');
    if (released === null) return c.json({ error: 'session not active' }, 404);
    return c.json({ sessionId: body.sessionId, released });
  });

  // GET /stream — Phase 3.2 SSE: live incidents.
  //
  // Replays a snapshot of recent incidents from the ring (so a dashboard
  // that opens mid-storm immediately sees the latest ~100), then streams
  // every new incident as it fires. Per-connection heartbeats keep
  // proxies from dropping the long-lived response.
  //
  // Query: `?since=N` filters the replayed snapshot to detectedAtMs > N.
  //        Use 0 (default) to get the full ring.
  app.get('/api/admin/supervisor/stream', (c) => {
    const sinceMs = Number(c.req.query('since') ?? 0);
    return streamSSE(c, async (stream) => {
      let seq = 0;
      const send = async (env: SupervisorIncidentEnvelope): Promise<void> => {
        try {
          await stream.writeSSE({
            id: String(seq++),
            event: 'incident',
            data: JSON.stringify(env),
          });
        } catch {
          /* client likely disconnected */
        }
      };
      // Phase 3.2 fix — emit a `connected` event immediately so the
      // dev proxy + client see headers and a payload right away. Without
      // this the connection waits for the first incident (or 20s
      // heartbeat) and the Vite proxy logs noisy ECONNREFUSEDs from
      // EventSource auto-retries when the backend reloads.
      try {
        await stream.writeSSE({
          id: String(seq++),
          event: 'connected',
          data: JSON.stringify({ ts: Date.now() }),
        });
      } catch {
        /* client gone before first byte */
      }
      const stopHeartbeat = attachHeartbeat(stream);
      const unsubscribe = subscribeToSupervisorIncidents((env) => {
        void send(env);
      });
      // Replay the ring so new clients see immediate context.
      for (const env of recentSupervisorIncidents()) {
        if (Number.isFinite(sinceMs) && env.detectedAtMs <= sinceMs) continue;
        await send(env);
      }
      // Hold the stream open until the client disconnects. Hono's
      // streamSSE awaits this async function; we await a never-resolving
      // promise + clean up in onClose.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          unsubscribe();
          stopHeartbeat();
          resolve();
        });
      });
    });
  });
}

/**
 * Worker-or-legacy fallback. Routes everything through the worker pool
 * when worker mode is on; otherwise calls the main supervisor singleton.
 * Returns null when neither path can satisfy.
 */
async function pumpSupervisorRpc<R = unknown>(
  sessionId: number,
  method: string,
  args: unknown[] = [],
): Promise<R | null> {
  if (workerOrchestratorEnabled()) {
    try {
      const pool = getWorkerOrchestratorPool();
      return await pool.supervisorRpc<R>(sessionId, method, args);
    } catch {
      return null;
    }
  }
  const sup = getGlobalAgentSupervisor();
  if (!sup) return null;
  // Legacy mode — supervisor in main. The methods used by admin are
  // synchronous; we wrap as a typed dispatcher.
  const dispatcher = sup as unknown as Record<string, (...args: unknown[]) => unknown>;
  const fn = dispatcher[method];
  if (typeof fn !== 'function') return null;
  return fn.apply(sup, args) as R;
}
