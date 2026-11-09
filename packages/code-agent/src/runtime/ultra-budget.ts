import { randomUUID } from 'node:crypto';
import type { CollaborationBudget } from '@mcp/session-storage/collaboration/budget.js';

export interface UltraSettlement { tokens?: number; costUsd?: number | null; unknown?: boolean }
export type UltraReservationRelease = ((usage?: UltraSettlement) => Promise<void>) & { reservationId: string };
export class UltraAgentBudget {
  private active = 0;
  private used = 0;
  private waiters = new Set<() => void>();
  constructor(readonly maxParallel: number, readonly maxAgents: number, readonly ledger?: CollaborationBudget) {}
  async acquire(signal?: AbortSignal): Promise<UltraReservationRelease> {
    const id = randomUUID();
    const deadline = Date.now() + 60_000;
    for (;;) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error('waiting_capacity: existing work still owns the available slots; collect or reconcile it');
      if ((!this.ledger && this.used >= this.maxAgents) || this.maxParallel < 1) throw new Error('budget_exhausted: finish with existing agents');
      if (this.active < this.maxParallel) {
        this.active++;
        try { await this.ledger?.reserve(id, String(process.pid)); break; }
        catch (error) { this.active--; if (!(error instanceof Error) || error.message !== 'waiting_capacity') throw error; }
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => done(), 1000);
        const done = () => { clearTimeout(timer); this.waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
        this.waiters.add(done); signal?.addEventListener('abort', done, { once: true });
        if (signal?.aborted) done();
      });
    }
    this.used++;
    let released = false;
    return Object.assign(async (usage?: UltraSettlement) => {
      if (released) return;
      await this.ledger?.settle(id, usage?.tokens ?? 0, usage?.costUsd ?? null, usage?.unknown ?? false);
      released = true; this.active--;
      for (const wake of [...this.waiters]) wake();
    }, { reservationId: id });
  }
}
