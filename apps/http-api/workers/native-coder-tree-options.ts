import type { PreparedCoderInputs } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
import type { NativeCoderTreeOptions } from './native-coder-tree.js';

/** Platform ceilings apply to the full attempt tree, including resumptions. */
export function nativeCoderTreeOptions(prepared: PreparedCoderInputs): NativeCoderTreeOptions {
  const policy = prepared.preparation.policy.runtime?.subagents;
  if (policy?.enabled === false || policy?.maxDepth === 0
    || !prepared.registry.list().some(tool => ['spawn_agent', 'resume_agent', 'request_review', 'workflow', 'execute_tasks', 'docs_deep_research'].includes(tool.name))) {
    return { maxAgents: 1, maxDepth: 0, maxParallel: 1 };
  }
  return { maxAgents: 64, maxDepth: Math.min(policy?.maxDepth ?? 4, 32), maxParallel: Math.min(policy?.maxParallel ?? 4, 8) };
}
