/**
 * Diagnostic endpoint for the worker pools (P13/P17).
 *
 * `GET /api/admin/workers` returns a snapshot of every spawned
 * worker_thread alongside its lifecycle state. Used by operators to
 * confirm `MCP_ORCHESTRATOR_WORKER=1` / `MCP_CODER_WORKER=1` are
 * actually taking effect — without grep'ing logs.
 *
 * Response shape:
 * ```json
 * {
 *   "company": {
 *     "enabled": true,
 *     "workers": [
 *       { "sessionId": 42, "workerState": "running", "lastTouchedAt": …, "idleMs": 1234 }
 *     ]
 *   },
 *   "coder": {
 *     "enabled": false,
 *     "workers": []
 *   },
 *   "node": {
 *     "pid": 12345,
 *     "uptimeSec": 600,
 *     "memMB": 128
 *   }
 * }
 * ```
 *
 * The response is intentionally tiny — purely metadata, no per-event
 * detail. The dashboard doesn't currently consume it; it's for
 * `curl http://localhost:5173/api/admin/workers | jq` during smoke
 * testing.
 */
import type { Hono } from 'hono';
import {
  describeWorkerOrchestratorStatus,
  getWorkerOrchestratorPool,
  workerOrchestratorEnabled,
} from '../../../sse/workerPoolSingleton.js';
import {
  coderWorkerEnabled,
  describeCoderWorkerStatus,
  getCoderWorkerPool,
} from '../../../sse/coderWorkerPoolSingleton.js';

interface WorkerRow {
  sessionId: number;
  workerState: string;
  lastTouchedAt: number;
  idleMs: number;
}

interface WorkersResponse {
  company: {
    enabled: boolean;
    envFlag: boolean;
    /** Free-form explanation of `enabled` — useful for "ON but file missing" diagnoses. */
    reason: string | null;
    /** Resolved worker file the pool would load (null when not resolvable). */
    workerFile: string | null;
    workers: WorkerRow[];
  };
  coder: {
    enabled: boolean;
    envFlag: boolean;
    reason: string | null;
    workerFile: string | null;
    workers: WorkerRow[];
  };
  node: { pid: number; uptimeSec: number; memMB: number };
}

export function mountWorkersDiagnosticRoute(app: Hono): void {
  app.get('/api/admin/workers', (c) => {
    const company: WorkerRow[] = [];
    const coder: WorkerRow[] = [];

    // Each pool is lazy — only construct if the flag was on AND the
    // worker file exists. We check via `*Enabled()` so a misconfigured
    // dev environment doesn't accidentally trip the existsSync probe.
    if (workerOrchestratorEnabled()) {
      try {
        company.push(...getWorkerOrchestratorPool().snapshot());
      } catch { /* pool not initialized yet */ }
    }
    if (coderWorkerEnabled()) {
      try {
        coder.push(...getCoderWorkerPool().snapshot());
      } catch { /* pool not initialized yet */ }
    }

    const mem = process.memoryUsage();
    const companyStatus = describeWorkerOrchestratorStatus();
    const coderStatus = describeCoderWorkerStatus();
    const body: WorkersResponse = {
      company: {
        enabled: companyStatus.enabled,
        envFlag: companyStatus.envFlag,
        reason: companyStatus.reason,
        workerFile: companyStatus.resolved?.file ?? null,
        workers: company,
      },
      coder: {
        enabled: coderStatus.enabled,
        envFlag: coderStatus.envFlag,
        reason: coderStatus.reason,
        workerFile: coderStatus.resolved?.file ?? null,
        workers: coder,
      },
      node: {
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        memMB: Math.round(mem.rss / (1024 * 1024)),
      },
    };
    return c.json(body);
  });
}
