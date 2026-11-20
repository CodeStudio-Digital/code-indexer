import type { CoderTool } from '../core/tool.js';
import { resolveToolMetadata } from '../core/policy.js';

/** Shared by discovery and dispatch: control boundaries need a top-level call. */
export function canInvokeInsideCodeExec(tool: CoderTool): boolean {
  if (resolveToolMetadata(tool).interactive) return false;
  return !(
    tool.name.startsWith('spawn_') || tool.name === 'resume_agent'
    || tool.name === 'code_exec' || tool.name === 'execute_task'
    || tool.name === 'task_complete'
    || tool.name === 'view_image' || tool.name === 'view_video'
  );
}
