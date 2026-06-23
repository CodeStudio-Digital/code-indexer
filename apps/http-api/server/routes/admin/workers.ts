/**
 * Diagnostic endpoint for the worker pools.
 *
 * `GET /api/admin/workers` returns a snapshot of every spawned
 * worker_thread alongside its lifecycle state. The company orchestrator
 * is workers-only (no env gate); the coder pool stays env-gated via
 * `MCP_CODER_WORKER=1`. Use this endpoint to confirm both are taking
 * effect — without grep'ing logs.
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
 * `curl http://localhost:7317/api/admin/workers | jq` during smoke
 * testing.
 */
import type { Hono } from 'hono';
import {
  describeWorkerOrchestratorStatus,
  getWorkerOrchestratorPool,
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
  // Company orchestrator: workers-only architecture, no env gate.
  // `enabled` reflects whether the worker file resolved.
  company: {
    enabled: boolean;
    reason: string | null;
    workerFile: string | null;
    workers: WorkerRow[];
  };
  // Coder runner pool: still env-gated via MCP_CODER_WORKER.
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

    // Company pool: always available when the worker file resolves.
    // The server refuses to boot otherwise (see startServer).
    try {
      company.push(...getWorkerOrchestratorPool().snapshot());
    } catch { /* pool not initialized yet */ }
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
