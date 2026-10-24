import type { AgentTreeMember, AgentTreeWaitResult } from '@mcp/code-agent/ports/agent-tree-port.js';

/** Bounded live-tree projection. Admission comes from the durable owner;
 * inventory entries never authorize launching or replaying an attempt. */
export class NativeTreeInventory {
  private readonly members = new Map<string, AgentTreeMember>();
  private readonly changed = new Set<() => void>();
  private readonly waits = new Map<string, Set<string>>();
  get pendingWaitCount() { return this.waits.size; }
  constructor(rootAgentRunId: string) {
    this.members.set(rootAgentRunId, { path: '/root', role: 'coder', agent_run_id: rootAgentRunId,
      status: 'running', is_self: false, is_master: false, is_alive: true });
  }
  admit(input: { agentRunId: string; parentAgentRunId: string; role: string; provider: string; model: string }): void {
    const parent = this.members.get(input.parentAgentRunId);
    if (!parent || this.members.has(input.agentRunId) || this.members.size >= 256
      || !/^[a-z\d-]{1,128}$/i.test(input.agentRunId)) throw new Error('Invalid native tree inventory admission');
    this.members.set(input.agentRunId, { path: `${parent.path}/agent-${input.agentRunId}`, role: input.role,
      agent_run_id: input.agentRunId, status: 'starting', is_self: false, is_master: false,
      provider: input.provider, model: input.model });
  }
  update(id: string, patch: Partial<Pick<AgentTreeMember, 'provider' | 'model' | 'status' | 'is_alive'>>): void {
    const member = this.members.get(id);
    if (!member) throw new Error('Native tree inventory has no owned member');
    Object.assign(member, patch);
    for (const notify of [...this.changed]) notify();
  }
  list(callerAgentRunId: string): AgentTreeMember[] {
    if (!this.members.has(callerAgentRunId)) throw new Error('Foreign native tree inventory caller');
    return [...this.members.values()].map(member => ({ ...member, is_self: member.agent_run_id === callerAgentRunId }));
  }

  async wait(caller: string, input: { targets: string[]; timeoutMs: number; signal?: AbortSignal }): Promise<AgentTreeWaitResult> {
    input.signal?.throwIfAborted();
    const all = this.list(caller), self = all.find(m => m.is_self)!;
    if (!input.targets.length || input.targets.length > 256 || !Number.isFinite(input.timeoutMs)
      || input.timeoutMs < 0 || input.timeoutMs > 1_800_000) throw new Error('Invalid native agent wait bounds');
    if (this.waits.has(caller)) throw new Error('Caller already owns an agent wait');
    const ids = new Set(input.targets.map(target => {
      const member = all.find(m => m.path === target || m.agent_run_id === target);
      if (!member) throw new Error('Agent wait target is outside this owned tree');
      if (member.is_self || self.path.startsWith(member.path + '/')) throw new Error('Cannot wait on self or an ancestor');
      if (member.status === 'starting') throw new Error('Agent is still queued; finish current work to release execution capacity');
      return member.agent_run_id;
    }));
    const reachesCaller = (id: string, visited = new Set<string>()): boolean => {
      if (id === caller) return true;
      if (visited.has(id)) return false;
      visited.add(id); return [...(this.waits.get(id) ?? [])].some(next => reachesCaller(next, visited));
    };
    if ([...ids].some(id => reachesCaller(id))) throw new Error('Agent wait would create a dependency cycle');
    this.waits.set(caller, ids);
    try {
      return await new Promise<AgentTreeWaitResult>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const snapshot = () => this.list(caller).filter(m => ids.has(m.agent_run_id));
        const cleanup = () => { if (timer) clearTimeout(timer); this.changed.delete(check); input.signal?.removeEventListener('abort', abort); };
        const finish = (kind: AgentTreeWaitResult['kind']) => {
          if (settled) return; settled = true; cleanup(); resolve({ kind, agents: snapshot() });
        };
        const abort = () => { if (settled) return; settled = true; cleanup(); reject(input.signal?.reason); };
        const check = () => {
          const members = snapshot();
          if (members.every(m => ['completed', 'interrupted', 'failed'].includes(m.status))) finish('all_done');
          else if (members.some(m => m.status === 'waiting')) finish('attention');
        };
        this.changed.add(check); input.signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish('timeout'), input.timeoutMs);
        if (input.signal?.aborted) abort(); else check();
      });
    } finally { this.waits.delete(caller); }
  }
}
