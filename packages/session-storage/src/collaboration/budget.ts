import type { BudgetLimits } from '@mcp/agent-runtime-contracts';
import { CollaborationRevisions } from './revisions.js';
import type { CollaborationFiles } from './files.js';

export interface BudgetReservation {
  kind?: 'agent' | 'model' | 'wake' | 'suggestion';
  runId?: string;
  createdAt?: number;
  id: string; owner: string; state: 'reserved' | 'settled' | 'unknown';
  tokensReserved: number; costReserved: number | null; tokens: number; cost: number | null;
}
export interface BudgetState {
  rootId: string; limits: BudgetLimits; stopped: boolean; epoch: number;
  reservations: Record<string, BudgetReservation>;
}

/** One aggregate per human work root. Unknown usage holds its reservation;
 * restarting a runner or adding a child never creates additional credit. */
export class CollaborationBudget {
  readonly revisions: CollaborationRevisions;
  constructor(readonly files: CollaborationFiles, readonly rootId: string, readonly limits: BudgetLimits) {
    this.revisions = new CollaborationRevisions(files);
  }
  private initial(): BudgetState { return { rootId: this.rootId, limits: this.limits, stopped: false, epoch: 0, reservations: {} }; }
  async state(): Promise<BudgetState> { return (await this.revisions.read<BudgetState>('budgets', this.rootId))?.value ?? this.initial(); }
  async reserve(id: string, owner: string, tokens = 0, cost: number | null = null,
    kind: NonNullable<BudgetReservation['kind']> = 'agent'): Promise<BudgetReservation> {
    const row = await this.revisions.change('budgets', this.rootId, this.initial(), state => {
      if (state.reservations[id]) return state;
      if (state.stopped) throw new Error('budget_stopped');
      const rows = Object.values(state.reservations);
      if (kind === 'agent' && rows.some(r => (r.kind ?? 'agent') === 'agent' && r.state === 'unknown')) throw new Error('effect_unknown: reconcile the existing agent reservation before admitting another');
      if (kind === 'agent' && rows.filter(r => (r.kind ?? 'agent') === 'agent').length >= state.limits.maxStarts) throw new Error('budget_exhausted: agent starts');
      if (kind === 'agent' && rows.filter(r => (r.kind ?? 'agent') === 'agent' && r.state !== 'settled').length >= Math.min(state.limits.maxParallel, this.limits.maxParallel)) throw new Error('waiting_capacity');
      if (!Number.isFinite(tokens) || tokens < 0 || (cost !== null && (!Number.isFinite(cost) || cost < 0))) throw new Error('invalid_budget_reservation');
      const tokenUse = rows.reduce((sum, r) => sum + (r.state === 'settled' ? r.tokens : Math.max(r.tokens, r.tokensReserved)), 0);
      if (kind === 'model' && state.limits.maxTokens !== undefined && (tokens <= 0 || tokenUse + tokens > state.limits.maxTokens)) throw new Error('budget_exhausted: tokens');
      if ((kind === 'model' || kind === 'suggestion') && state.limits.maxCostUsd !== undefined) {
        const charged = rows.filter(r => r.kind === 'model' || r.kind === 'suggestion');
        if (cost === null || charged.some(r => r.state === 'settled' && r.cost === null)) throw new Error('budget_cost_unknown');
        const spent = charged.reduce((sum, r) => sum + (r.state === 'settled' ? r.cost! : Math.max(r.cost ?? 0, r.costReserved ?? Infinity)), 0);
        if (spent + cost > state.limits.maxCostUsd) throw new Error('budget_exhausted: cost');
      }
      state.reservations[id] = { id, owner, kind, createdAt: Date.now(), state: 'reserved', tokensReserved: tokens, costReserved: cost, tokens: 0, cost: null };
      return state;
    });
    return row.value.reservations[id];
  }
  async settle(id: string, tokens: number, cost: number | null, unknown = false): Promise<void> {
    if (!Number.isFinite(tokens) || tokens < 0 || (cost !== null && (!Number.isFinite(cost) || cost < 0))) throw new Error('invalid_budget_settlement');
    await this.revisions.change('budgets', this.rootId, this.initial(), state => {
      const row = state.reservations[id];
      if (!row) throw new Error('unknown_budget_reservation');
      if (row.state === 'settled') return state;
      row.tokens = Math.max(row.tokens, tokens); row.cost = cost;
      row.state = unknown ? 'unknown' : 'settled';
      return state;
    });
  }
  async bind(id: string, sessionId: string, runId: string): Promise<void> {
    await this.revisions.change('budgets', this.rootId, this.initial(), state => {
      const row = state.reservations[id];
      if (!row || (row.runId && row.runId !== runId)) throw new Error('budget_binding_conflict');
      row.owner = sessionId; row.runId = runId; return state;
    });
  }
  async stop(): Promise<void> {
    await this.revisions.change('budgets', this.rootId, this.initial(), state => ({ ...state, stopped: true, epoch: state.epoch + 1 }));
  }
  /** Explicit human setting only; does not erase starts, usage or reservations. */
  async configure(limits: Partial<BudgetLimits>): Promise<void> {
    await this.revisions.change('budgets', this.rootId, this.initial(), state => {
      const next = { ...state.limits, ...limits };
      if (!Number.isInteger(next.maxParallel) || next.maxParallel < 0 || next.maxParallel > 24
        || !Number.isInteger(next.maxStarts) || next.maxStarts < 1 || next.maxStarts > 1000
        || (next.maxTokens !== undefined && (!Number.isFinite(next.maxTokens) || next.maxTokens < 1))
        || (next.maxCostUsd !== undefined && (!Number.isFinite(next.maxCostUsd) || next.maxCostUsd < 0))) throw new Error('invalid_budget_limits');
      return { ...state, limits: next };
    });
  }
}
