import type { ToolContext, ToolResult } from '../core/tool.js';

/** A workspace switch ends the current attempt. Its immutable intent is
 * committed with the tool result before the product admits a new writer. */
export interface NativeWorktreeTransition {
  readonly version: 1;
  readonly id: string;
  readonly toolUseId: string;
  readonly toolName: 'enter_worktree' | 'exit_worktree';
  readonly projectRoot: string;
  readonly sourceCwd: string;
  readonly action: 'enter' | 'keep' | 'remove';
  readonly name?: string;
  readonly branch?: string;
  readonly discardChanges?: boolean;
}

export interface WorktreeTransitionPort {
  request(toolName: NativeWorktreeTransition['toolName'], args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
