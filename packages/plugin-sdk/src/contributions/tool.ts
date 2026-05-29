import type { ContributedTool } from './types.js';

/**
 * Declare an agent tool. Identity helper — gives full typing on the handler
 * + a stable seam for future defaults. The handler runs in the plugin worker.
 */
export function contributeTool(tool: ContributedTool): ContributedTool {
  return tool;
}
