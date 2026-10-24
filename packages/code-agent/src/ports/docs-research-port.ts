import type { ToolContext, ToolResult } from '../core/tool.js';

/** Native research stays inside the admitted tree and its provider budget. */
export interface DocsResearchPort {
  readonly runtimeGeneration: 'rust_v1';
  readonly ownerAgentRunId: string;
  /** Host proof confirmed only after restricted children settle without unknown effects. */
  isReadOnlyInvocation(invocationId: string): boolean;
  research(input: { query: string; collections?: string[]; maxTurns?: number }, context: ToolContext): Promise<ToolResult>;
}
