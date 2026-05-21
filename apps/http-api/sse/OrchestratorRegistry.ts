/**
 * OrchestratorRegistry — map of active CompanyOrchestrators with TTL-based
 * eviction. Replaces the inline setTimeout spread across stream.ts.
 *
 * When a stream ends, the entry is scheduled for eviction after TTL ms.
 * If the user reconnects within that window, eviction is cancelled and
 * the orchestrator is reused.
 *
 * TTL is configurable via CODER_COMPANY_ORCHESTRATOR_TTL_MS (default 5min).
 *
 * **P13b — transparent worker pool fallback.** When the operator flips
 * `MCP_ORCHESTRATOR_WORKER=1`, the company `/start` route registers
 * its orchestrator into the worker pool instead of this registry. Every
 * other route still calls `orchestratorRegistry.get(id)` — so this
 * class now falls through to the pool on `get()` / `has()` lookups.
 * That keeps all 12 consumers (kanban, services, sandbox, qa, children,
 * archives, ws, …) working without touching them individually.
 */

import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import {
  getWorkerOrchestratorPool,
  workerOrchestratorEnabled,
} from './workerPoolSingleton.js';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface Entry {
  orchestrator: CompanyOrchestrator;
  evictTimer: NodeJS.Timeout | null;
}

export class OrchestratorRegistry {
  private readonly entries = new Map<number, Entry>();
  private readonly ttlMs: number;

  constructor(ttlMs?: number) {
    const envTTL = Number(process.env.CODER_COMPANY_ORCHESTRATOR_TTL_MS);
    this.ttlMs = Number.isFinite(envTTL) && envTTL > 0
      ? envTTL
      : (ttlMs ?? DEFAULT_TTL_MS);
  }

  /** Register a new orchestrator. Replaces any existing entry for the same id. */
  set(id: number, orchestrator: CompanyOrchestrator): void {
    this.cancelEviction(id);
    this.entries.set(id, { orchestrator, evictTimer: null });
  }

  /**
   * Get the orchestrator, cancelling any pending eviction as a side effect.
   *
   * Lookup order:
   *   1. In-process registry (legacy `/start` path or worker flag off)
   *   2. Worker pool (P13b — when `MCP_ORCHESTRATOR_WORKER=1` and the
   *      pool has a worker for this session)
   *
   * Both branches return the same `CompanyOrchestrator` shape. Routes
   * don't need to know which path served the lookup — the worker-backed
   * orchestrator is a transparent JS Proxy that forwards method calls
   * to the worker thread.
   */
  get(id: number): CompanyOrchestrator | undefined {
    const entry = this.entries.get(id);
    if (entry) {
      this.cancelEviction(id);
      return entry.orchestrator;
    }
    if (workerOrchestratorEnabled()) {
      const pooled = getWorkerOrchestratorPool().get(id);
      if (pooled) return pooled.orchestrator;
    }
    return undefined;
  }

  /**
   * Same fallback as `get()` — workers count as "present" so the
   * existing `if (orchestratorRegistry.has(id)) ...` checks downstream
   * keep semantic parity when the flag is on.
   */
  has(id: number): boolean {
    if (this.entries.has(id)) return true;
    if (workerOrchestratorEnabled()) {
      return getWorkerOrchestratorPool().has(id);
    }
    return false;
  }

  /** Immediate removal — used for abort/cleanup paths. */
  delete(id: number): void {
    this.cancelEviction(id);
    this.entries.delete(id);
    // Worker-pool delete is async; fire-and-forget so we don't block
    // the synchronous registry contract callers depend on. Pool
    // eviction tears the worker down cleanly via SIGTERM-equivalent.
    if (workerOrchestratorEnabled()) {
      void getWorkerOrchestratorPool().evict(id);
    }
  }

  /**
   * Schedule eviction after TTL. If the caller .get()s the entry before
   * the timer fires, eviction is cancelled. Idempotent: calling twice
   * resets the timer.
   *
   * For worker-pool entries this is a no-op because the pool runs its
   * own TTL sweep (`WorkerOrchestratorPool` constructor).
   */
  scheduleEviction(id: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.evictTimer) clearTimeout(entry.evictTimer);
    entry.evictTimer = setTimeout(() => {
      this.entries.delete(id);
    }, this.ttlMs);
  }

  private cancelEviction(id: number): void {
    const entry = this.entries.get(id);
    if (entry?.evictTimer) {
      clearTimeout(entry.evictTimer);
      entry.evictTimer = null;
    }
  }
}

/** Singleton shared across stream routes. */
export const orchestratorRegistry = new OrchestratorRegistry();
