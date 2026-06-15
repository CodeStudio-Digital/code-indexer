/**
 * MemoryLedger — pull-based registry of subsystem memory estimates.
 *
 * Subsystems (embedding stores, LSP manager, run buses, caches) register
 * a cheap estimator closure at construction time; the perf sampler calls
 * `snapshot()` every tick and the admin panel renders whatever happens to
 * be registered. Estimators must be O(1)-ish — counts and running byte
 * counters, never deep JSON.stringify over large graphs.
 *
 * Module-global singleton: registrations from anywhere in the main
 * process land in the same ledger. Worker threads have their own module
 * instance (module globals don't cross worker_threads) — their numbers
 * arrive via the `perf:memStats` RPC instead, not through this ledger.
 */

export interface LedgerEntry {
  /** Stable subsystem id, e.g. "embeddings.messages", "lsp.servers". */
  name: string;
  /** Item count (vectors, servers, sessions, models…). */
  count: number;
  /** Estimated bytes held, when computable. */
  bytes?: number;
  /** Free-form annotation (e.g. child PIDs, model id). */
  detail?: string;
}

export type LedgerEstimator = () =>
  | Omit<LedgerEntry, 'name'>
  | null
  | Promise<Omit<LedgerEntry, 'name'> | null>;

class MemoryLedger {
  private estimators = new Map<string, LedgerEstimator>();

  /** Register (or replace) a subsystem estimator. */
  register(name: string, fn: LedgerEstimator): void {
    this.estimators.set(name, fn);
  }

  unregister(name: string): void {
    this.estimators.delete(name);
  }

  /**
   * Evaluate every estimator. A throwing, rejecting or null-returning
   * estimator is skipped — diagnostics must never take the host down.
   */
  async snapshot(): Promise<LedgerEntry[]> {
    const jobs = Array.from(this.estimators.entries()).map(async ([name, fn]) => {
      try {
        const v = await fn();
        return v ? { name, ...v } : null;
      } catch {
        return null;
      }
    });
    const out = (await Promise.all(jobs)).filter((e): e is LedgerEntry => e != null);
    out.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
    return out;
  }
}

const ledger = new MemoryLedger();

export function getMemoryLedger(): MemoryLedger {
  return ledger;
}
