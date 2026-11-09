/**
 * Admin endpoints for the AgentSupervisor.
 *
 * Routes:
 *   GET  /api/admin/supervisor/status         — aggregated across all active workers
 *   GET  /api/admin/supervisor/status/:sessionId — live status of one session
 *   GET  /api/admin/supervisor/incidents?sessionId=X&limit=N — persisted log
 *   POST /api/admin/supervisor/release-quarantine — body {sessionId, role}
 *   POST /api/admin/supervisor/release-read-only  — body {sessionId}
 *   GET  /api/admin/supervisor/stream          — SSE of live incidents
 *
 * Architecture: each company-worker owns its supervisor instance.
 * Live status flows via `supervisor.rpc` MessageBridge to the worker.
 * Persisted incidents are read from each Company session bundle
 * (survive worker eviction / process restart without touching SQLite).
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  FileSupervisionPersistence,
  supervisorEnabled,
  type IncidentQueryRow,
} from '@mcp/company/services/supervisor/index.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import {
  asCompanySessionId,
  asSessionId,
  isUuid,
  type CompanySessionId,
} from '@mcp/session-storage';
import { getWorkerOrchestratorPool } from '../../../sse/workerPoolSingleton.js';
import {
  recentSupervisorIncidents,
  subscribeToSupervisorIncidents,
  type SupervisorIncidentEnvelope,
} from '../../../sse/supervisor-incident-bus.js';
import { attachHeartbeat } from '../../../sse/SSEHeartbeat.js';
import { readSupervisorStatus } from './supervisor-status.js';

interface SupervisorAdminDeps {
  sessionStore: FsSessionStore;
}

/**
 * Read incidents directly from the owning bundle. Works regardless of worker
 * liveness because the supervisor persists every incident as an independent
 * file. Handles are cached per bundle and contain no shared database state.
 */
class IncidentReader {
  private readonly handles = new Map<string, FileSupervisionPersistence>();

  constructor(private readonly sessionStore: FsSessionStore) {}

  async list(sessionId: CompanySessionId, limit: number): Promise<IncidentQueryRow[]> {
    try {
      await this.sessionStore.ensureCatalog();
      const entry = this.sessionStore.catalog.get(asSessionId(sessionId));
      if (
        entry == null ||
        (entry.session.kind !== 'company' && entry.session.kind !== 'app_studio')
      ) {
        return [];
      }
      const cacheKey = `${sessionId}:${entry.location.bundle_path}`;
      let handle = this.handles.get(cacheKey);
      if (handle == null) {
        handle = new FileSupervisionPersistence({
          companySessionId: sessionId,
          sessionRoot: entry.location.bundle_path,
        });
        this.handles.set(cacheKey, handle);
      }
      return handle.listRecentIncidents(sessionId, limit);
    } catch {
      return [];
    }
  }
}

export function mountSupervisorAdminRoutes(app: Hono, deps: SupervisorAdminDeps): void {
  const incidentReader = new IncidentReader(deps.sessionStore);

  // GET /status — aggregated across all active workers
  app.get('/api/admin/supervisor/status', async (c) => {
    const pool = getWorkerOrchestratorPool();
    return c.json(await readSupervisorStatus(pool, undefined, supervisorEnabled()));
  });

  // GET /status/:sessionId — single session
  app.get('/api/admin/supervisor/status/:sessionId', async (c) => {
    const sessionId = parseCompanySessionId(c.req.param('sessionId'));
    if (sessionId == null) return c.json({ error: 'invalid sessionId' }, 400);
    const result = await readSupervisorStatus(getWorkerOrchestratorPool(), sessionId, supervisorEnabled());
    return c.json({ ...result, sessionId, status: result.sessions[0]?.status ?? null });
  });

  // GET /incidents?sessionId=X&limit=N — bundle-backed, survives worker eviction
  app.get('/api/admin/supervisor/incidents', async (c) => {
    const sessionId = parseCompanySessionId(c.req.query('sessionId'));
    const limit = Math.min(500, Number(c.req.query('limit') ?? 50));
    if (sessionId == null) return c.json({ error: 'sessionId required' }, 400);
    if (!Number.isFinite(limit) || limit < 1) return c.json({ error: 'invalid limit' }, 400);
    const incidents = await incidentReader.list(sessionId, limit);
    return c.json({ sessionId, incidents });
  });

  // POST /release-quarantine — body { sessionId, role }
  app.post('/api/admin/supervisor/release-quarantine', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { sessionId?: unknown; role?: unknown }
      | null;
    const sessionId = parseCompanySessionId(body?.sessionId);
    if (sessionId == null || typeof body?.role !== 'string') {
      return c.json({ error: 'body requires {sessionId:uuid, role:string}' }, 400);
    }
    const released = await pumpSupervisorRpc<boolean>(sessionId, 'releaseRoleQuarantine', [
      body.role,
    ]);
    if (released === null) return c.json({ error: 'session not active' }, 404);
    return c.json({ sessionId, role: body.role, released });
  });

  // POST /release-read-only — body { sessionId }
  app.post('/api/admin/supervisor/release-read-only', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { sessionId?: unknown }
      | null;
    const sessionId = parseCompanySessionId(body?.sessionId);
    if (sessionId == null) {
      return c.json({ error: 'body requires {sessionId:uuid}' }, 400);
    }
    const released = await pumpSupervisorRpc<boolean>(sessionId, 'releaseReadOnlyMode');
    if (released === null) return c.json({ error: 'session not active' }, 404);
    return c.json({ sessionId, released });
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
    const scope = c.req.query('sessionId');
    if (scope && !isUuid(scope)) return c.json({ error: 'invalid sessionId' }, 400);
    return streamSSE(c, async (stream) => {
      let seq = 0;
      const send = async (env: SupervisorIncidentEnvelope): Promise<void> => {
        if (scope && env.sessionId !== scope) return;
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
 * Bridge a supervisor method call to the worker that owns this session.
 * Returns null when no worker is active for the session id (idle /
 * evicted / never spawned).
 */
async function pumpSupervisorRpc<R = unknown>(
  sessionId: CompanySessionId,
  method: string,
  args: unknown[] = [],
): Promise<R | null> {
  try {
    const pool = getWorkerOrchestratorPool();
    return await pool.supervisorRpc<R>(sessionId, method, args);
  } catch {
    return null;
  }
}

function parseCompanySessionId(value: unknown): CompanySessionId | null {
  return isUuid(value) ? asCompanySessionId(value) : null;
}
