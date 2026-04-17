/**
 * OrchestratorRegistry — map of active CompanyOrchestrators with TTL-based
 * eviction. Replaces the inline setTimeout spread across stream.ts.
 *
 * When a stream ends, the entry is scheduled for eviction after TTL ms.
 * If the user reconnects within that window, eviction is cancelled and
 * the orchestrator is reused.
 *
 * TTL is configurable via CODER_COMPANY_ORCHESTRATOR_TTL_MS (default 5min).
 */

import type { CompanyOrchestrator } from '../../../core/coder/company/orchestrator.js';

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

  /** Get the orchestrator, cancelling any pending eviction as a side effect. */
  get(id: number): CompanyOrchestrator | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.cancelEviction(id);
    return entry.orchestrator;
  }

  has(id: number): boolean {
    return this.entries.has(id);
  }

  /** Immediate removal — used for abort/cleanup paths. */
  delete(id: number): void {
    this.cancelEviction(id);
    this.entries.delete(id);
  }

  /**
   * Schedule eviction after TTL. If the caller .get()s the entry before
   * the timer fires, eviction is cancelled. Idempotent: calling twice
   * resets the timer.
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
