import { createHash } from 'node:crypto';
import type { InteractionResponse } from '@mcp/agent-runtime-host';
import type { PreparedCoderExecution } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
import type { BufferedEvent } from '../coder-bus.js';

const REVIEWS = new Set(['question', 'decision', 'plan', 'spec', 'tasks_posted', 'budget_request']);
const PROGRESS = new Set(['agents_group_start', 'agent_progress', 'agents_group_end', 'workflow_run_started', 'workflow_step_update', 'workflow_run_finished']);

/** Each child has its own durable response ledger. The parent only routes an
 * opaque UI identity to that child's facade; it never grants an approval itself.
 * Nested trees apply the same mapping at every boundary. */
export class NativeTreeInteractions {
  private readonly children = new Set<NativeChildInteractions>();
  constructor(private readonly emit: (event: string, data: unknown) => void) {}

  child(attemptId: string, agentRunId: string) {
    const child = new NativeChildInteractions(attemptId, agentRunId, this.emit,
      () => this.children.delete(child));
    this.children.add(child); return child;
  }
  get isWaiting() { return [...this.children].some(child => child.isWaiting); }
  hasPending(id: string) { return [...this.children].some(child => child.hasPending(id)); }
  owns(id: string) { return [...this.children].some(child => child.owns(id)); }
  async resolve(id: string, response: InteractionResponse) {
    const child = [...this.children].find(child => child.owns(id));
    if (!child) throw new Error('Native child interaction is not owned by this tree');
    await child.resolve(id, response);
  }
}

class NativeChildInteractions {
  private readonly routes = new Map<string, string>();
  private execution?: PreparedCoderExecution;
  private closed = false;
  constructor(private readonly attemptId: string, private readonly agentRunId: string,
    private readonly emit: (event: string, data: unknown) => void, private readonly remove: () => void) {}
  attach(execution: PreparedCoderExecution) {
    if (this.closed || this.execution) throw new Error('Native child interaction owner is closed or already attached');
    this.execution = execution;
  }
  get isWaiting() { return !this.closed && (this.execution?.isWaitingForInput?.() ?? false); }
  owns(id: string) { return !this.closed && this.routes.has(id); }
  hasPending(id: string) {
    const local = this.routes.get(id);
    return !this.closed && !!local && (this.execution?.isInteractionPending?.(local) ?? false);
  }
  async resolve(id: string, response: InteractionResponse) {
    const local = this.routes.get(id);
    if (this.closed || !local || !this.execution) throw new Error('Native child interaction is not ready');
    // Even duplicate ACKs go through the child's durable idempotency ledger.
    await this.execution.resolveInteraction(local, response);
  }
  forward(event: BufferedEvent) {
    if (this.closed || !event.data || typeof event.data !== 'object') return;
    const data = event.data as Record<string, unknown>;
    if (PROGRESS.has(event.event)) {
      const identity = event.event.startsWith('workflow_') ? data.workflow_id : data.groupId;
      if (typeof identity !== 'string' || !identity || identity.length > 1024) {
        throw new Error('Invalid native child progress identity');
      }
      // Keep the actual group identity: row cancel, resume and retained history
      // address it in the worker. Each boundary preserves the original owner.
      this.emit(event.event, { ...data, nativeTree: data.nativeTree ?? {
        agentRunId: this.agentRunId, attemptId: this.attemptId,
      } });
      return;
    }
    const approval = event.event === 'tool_approval_request' || event.event === 'tool_approval_resolved';
    if (!approval && !REVIEWS.has(event.event)) return;
    const original = approval ? data.toolUseId : data.id;
    if (typeof original !== 'string' || !original || original.length > 1024) throw new Error('Invalid native child interaction identity');
    const routed = `native-child:${this.attemptId}:${createHash('sha256').update(original).digest('hex')}`;
    const id = approval ? `tool_approval:${routed}` : routed;
    const local = approval ? `tool_approval:${original}` : original;
    if (event.event !== 'tool_approval_resolved') {
      if (!this.routes.has(id) && this.routes.size >= 1024) throw new Error('Native child interaction receipt bound exceeded');
      if (this.routes.has(id) && this.routes.get(id) !== local) throw new Error('Native child interaction identity collision');
      this.routes.set(id, local);
    } else if (!this.routes.has(id)) return;
    this.emit(event.event, { ...data, ...(approval ? { toolUseId: routed, nested: true } : { id: routed }),
      ...(event.event === 'budget_request' ? { ask_id: routed } : {}),
      agentRunId: this.agentRunId, attemptId: this.attemptId });
  }
  close() { this.closed = true; this.routes.clear(); this.execution = undefined; this.remove(); }
}
