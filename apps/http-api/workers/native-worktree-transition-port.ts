import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { err, ok, type ToolContext, type ToolResult } from '@mcp/code-agent/core/tool.js';
import type { NativeWorktreeTransition, WorktreeTransitionPort } from '@mcp/code-agent/ports/worktree-transition-port.js';
import { nativeToolUseId } from '@mcp/agent-runtime-host';
import type { ToolRegistryHostCapabilityExecutorOptions } from '@mcp/code-agent/runtime/tool-registry-host-capability-executor.js';

/** Staging performs no Git effects and never mutates the sealed ToolContext.
 * Only the exact successful Host result may carry this receipt into Rust. */
export class NativeWorktreeTransitionPort implements WorktreeTransitionPort {
  private pending?: NativeWorktreeTransition;
  constructor(private readonly projectRoot: string, private readonly sourceCwd: string,
    private readonly assertCurrent: () => void) {}

  async request(toolName: NativeWorktreeTransition['toolName'], args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    this.assertCurrent(); context.signal?.throwIfAborted();
    if (this.pending) return err('A workspace transition is already pending at this attempt boundary.');
    if (!context.currentToolUseId || !samePath(context.cwd, this.sourceCwd)) throw new Error('Native worktree invocation lost its sealed workspace or attribution');
    const id = createHash('sha256').update(context.currentToolUseId).digest('hex');
    const common = { version: 1 as const, id, toolUseId: context.currentToolUseId, toolName,
      projectRoot: resolve(this.projectRoot), sourceCwd: resolve(this.sourceCwd) };
    if (toolName === 'enter_worktree') {
      if (!samePath(this.projectRoot, this.sourceCwd)) return err('Already inside a worktree. Call exit_worktree first.');
      if (args.name !== undefined && typeof args.name !== 'string' || args.branch !== undefined && typeof args.branch !== 'string') return err('Worktree name and branch must be strings.');
      const name = (args.name as string | undefined)?.trim() || `wt-${id.slice(0, 12)}`;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return err('Invalid managed worktree name.');
      const branch = (args.branch as string | undefined)?.trim() || `coder/${name}`;
      if (branch.length > 1024 || /[\x00-\x20\x7f]/.test(branch) || branch.startsWith('-')) return err('Invalid worktree branch.');
      this.pending = { ...common, action: 'enter', name, branch };
    } else {
      if (args.action !== 'keep' && args.action !== 'remove') return err('action must be "keep" or "remove"');
      if (args.discard_changes !== undefined && typeof args.discard_changes !== 'boolean') return err('discard_changes must be a boolean.');
      if (samePath(this.projectRoot, this.sourceCwd)) return ok('No worktree currently active — nothing to exit.');
      this.pending = { ...common, action: args.action, discardChanges: args.discard_changes === true };
    }
    return ok('Workspace transition accepted. The current attempt will checkpoint and close before Git and the next attempt switch directories. Remaining tools in this batch must be requested again after the transition.');
  }

  result(input: Parameters<NonNullable<ToolRegistryHostCapabilityExecutorOptions['commitResult']>>[0]): NativeWorktreeTransition | undefined {
    if (input.toolName !== 'enter_worktree' && input.toolName !== 'exit_worktree') return undefined;
    if (!this.pending || input.result.isError || input.result.effectOutcome === 'unknown') return undefined;
    const id = nativeToolUseId(input.request.identity.attemptId, input.request.providerOperationId, input.request.toolUseId);
    if (this.pending.toolName !== input.toolName || this.pending.toolUseId !== id) throw new Error('Native worktree result attribution diverged');
    return structuredClone(this.pending);
  }

  get transition(): NativeWorktreeTransition | undefined { return this.pending && structuredClone(this.pending); }
}

export function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}
