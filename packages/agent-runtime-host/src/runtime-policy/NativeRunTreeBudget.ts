import type { agentV1Common } from '@mcp/agent-runtime-contracts';
import { ProviderGatewayError } from '../provider-gateway/ProviderGatewayError.js';

export interface NativeTreeConsumptionLimits {
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly maxAgents: number;
  readonly maxDepth: number;
  readonly deadlineAtUnixMs: number;
}
export interface NativeTreeConsumptionPort {
  /** Counts direct calls and calls nested inside scripts against the same pool. */
  take(): boolean;
  admitProviderOperation(identity: agentV1Common.AttemptIdentity, signal: AbortSignal): void;
  close(): void;
}
interface TreeMember { runId: string; depth: number; closed: boolean; parent?: TreeMember }

/** One coordinator owns the whole live tree. Monotonic counters are shared by
 * all attempt gateways; a failed call never refunds consumption. Each provider
 * frontier/effect is still durably committed by its attempt before dispatch.
 * After loss of this coordinator, admission receipts require reconciliation;
 * this object is never recreated to relaunch the same attempts. */
export class NativeRunTreeBudget {
  private turns = 0;
  private calls = 0;
  private readonly members = new Map<string, TreeMember>();
  readonly limits: NativeTreeConsumptionLimits;
  constructor(private readonly root: { agentRunId: string; attemptId: string }, limits: NativeTreeConsumptionLimits,
    private readonly signal: AbortSignal, private readonly now = Date.now) {
    for (const value of [limits.maxTurns, limits.maxToolCalls]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid native tree consumption limit');
    }
    if (!root.agentRunId || !root.attemptId || !Number.isSafeInteger(limits.deadlineAtUnixMs)
      || limits.deadlineAtUnixMs <= now() || !Number.isInteger(limits.maxAgents) || limits.maxAgents < 1 || limits.maxAgents > 256
      || !Number.isInteger(limits.maxDepth) || limits.maxDepth < 0 || limits.maxDepth > 32) throw new Error('Invalid native tree ownership or bounds');
    this.limits = Object.freeze({ ...limits });
    this.root = Object.freeze({ ...root });
    this.members.set(root.attemptId, { runId: root.agentRunId, depth: 0, closed: false });
  }

  rootPort(): NativeTreeConsumptionPort { return this.port(this.root.attemptId); }

  /** Supply only the result of durable child admission, before process launch.
   * Existing/uncertain admissions never receive a fresh consumption port. */
  childPort(admission: { kind: 'reserved' | 'existing'; context: { agentRunId: string; attemptId: string };
    rootAgentRunId: string; parentAgentRunId: string; spawnDepth: number }): NativeTreeConsumptionPort {
    this.signal.throwIfAborted();
    const parent = [...this.members.values()].find(member => member.runId === admission.parentAgentRunId);
    let ancestorClosed = false;
    for (let ancestor = parent; ancestor; ancestor = ancestor.parent) ancestorClosed ||= ancestor.closed;
    if (admission.kind !== 'reserved' || admission.rootAgentRunId !== this.root.agentRunId || !parent || ancestorClosed
      || admission.spawnDepth !== parent.depth + 1 || admission.spawnDepth > this.limits.maxDepth
      || this.members.size >= this.limits.maxAgents || !admission.context.attemptId || !admission.context.agentRunId
      || this.members.has(admission.context.attemptId) || [...this.members.values()].some(member => member.runId === admission.context.agentRunId)
      || this.now() >= this.limits.deadlineAtUnixMs) throw new Error('Native child consumption lacks a fresh owned reservation');
    this.members.set(admission.context.attemptId, { runId: admission.context.agentRunId, depth: admission.spawnDepth, closed: false, parent });
    return this.port(admission.context.attemptId);
  }

  get usage() { return Object.freeze({ turns: this.turns, toolCalls: this.calls, agents: this.members.size }); }

  private port(attemptId: string): NativeTreeConsumptionPort {
    const member = this.members.get(attemptId)!;
    const live = () => {
      for (let ancestor: TreeMember | undefined = member; ancestor; ancestor = ancestor.parent) if (ancestor.closed) return false;
      return !this.signal.aborted && this.now() < this.limits.deadlineAtUnixMs;
    };
    return {
      take: () => {
        if (!live() || this.calls >= (this.limits.maxToolCalls ?? Number.MAX_SAFE_INTEGER)) return false;
        this.calls++; return true;
      },
      admitProviderOperation: (identity, signal) => {
        signal.throwIfAborted(); this.signal.throwIfAborted();
        if (!live() || identity.rootAgentRunId !== this.root.agentRunId || identity.agentRunId !== member.runId
          || identity.attemptId !== attemptId) {
          throw new ProviderGatewayError('provider_run_tree_fenced', 'Native tree provider authority is fenced');
        }
        if (this.turns >= (this.limits.maxTurns ?? Number.MAX_SAFE_INTEGER)) {
          throw new ProviderGatewayError('provider_run_tree_budget_exhausted', 'Native tree provider budget is exhausted');
        }
        this.turns++;
      },
      close: () => { member.closed = true; },
    };
  }
}
