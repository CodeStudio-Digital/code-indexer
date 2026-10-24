import { nativeToolUseId } from '@mcp/agent-runtime-host';
import { parseNativeGoalState, parseNativeGoalMutation, type NativeGoalMutation, type NativeGoalState } from '@mcp/session-storage/native-goal-projection.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ToolRegistryHostCapabilityExecutorOptions } from '@mcp/code-agent/runtime/tool-registry-host-capability-executor.js';

/** Stages state inside the attributed result. Rust commits that result before
 * another sequential capability can observe it. No second session writer exists. */
export class NativeGoalPort {
  private state: NativeGoalState | null = null;
  private initialized = false;
  private readonly readInitial: () => NativeGoalState | null;
  private pending?: NativeGoalMutation;
  constructor(context: ToolContext, private readonly assertCurrent: () => void) {
    const getInitial = context.getGoalState;
    this.readInitial = () => {
      const initial = getInitial?.();
      return initial ? parseNativeGoalState(initial) : null;
    };
    // Legacy state may exceed the bounded native result envelope. Reject an
    // explicit goal operation without preventing unrelated tools from running.
    context.getGoalState = () => { this.initialize(); return this.state ? { ...this.state } : null; };
    context.upsertGoalState = (next, attribution) => this.stage(next, attribution);
    context.noteGoalUnchanged = attribution => {
      this.initialize();
      if (!this.state) throw new Error('Native goal no-op lacks a goal');
      this.stage(this.state, attribution);
    };
  }
  private initialize() {
    this.assertCurrent();
    if (this.initialized) return;
    this.state = this.readInitial();
    this.initialized = true;
  }
  private stage(next: unknown, attribution: { toolUseId: string; toolName: string }) {
    this.initialize();
    if (this.pending) throw new Error('Native goal has an unresolved staged result');
    this.pending = parseNativeGoalMutation({ version: 1, ...attribution, expected: this.state, next }, attribution.toolUseId, attribution.toolName);
  }
  result(input: Parameters<NonNullable<ToolRegistryHostCapabilityExecutorOptions['commitResult']>>[0]): NativeGoalMutation | undefined {
    if (!['create_goal', 'update_goal'].includes(input.toolName)) return undefined;
    this.assertCurrent();
    const pending = this.pending;
    this.pending = undefined;
    if (input.result.isError) {
      if (pending) throw new Error('Failed native goal result staged a mutation');
      return undefined;
    }
    const id = nativeToolUseId(input.request.identity.attemptId, input.request.providerOperationId, input.request.toolUseId);
    if (!pending || pending.toolUseId !== id || pending.toolName !== input.toolName) throw new Error('Successful native goal lacks its attributed mutation');
    this.state = pending.next;
    return pending;
  }
}
