import { expect, it } from 'vitest';
import { nativeCoderTreeOptions } from '../workers/native-coder-tree-options.js';
import type { PreparedCoderInputs } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
function prepared(names: string[], subagents?: { enabled: boolean; maxParallel: number; maxDepth: number }) {
  return { registry: { list: () => names.map(name => ({ name })) }, preparation: { policy: { runtime: { subagents } } } } as unknown as PreparedCoderInputs;
}
it('uses the configured subagent policy within platform ceilings', () => {
  expect(nativeCoderTreeOptions(prepared(['spawn_agent']))).toEqual({ maxAgents: 64, maxDepth: 4, maxParallel: 4 });
  expect(nativeCoderTreeOptions(prepared(['workflow']))).toEqual({ maxAgents: 64, maxDepth: 4, maxParallel: 4 });
  expect(nativeCoderTreeOptions(prepared(['request_review'], { enabled: true, maxParallel: 2, maxDepth: 3 })))
    .toEqual({ maxAgents: 64, maxDepth: 3, maxParallel: 2 });
  expect(nativeCoderTreeOptions(prepared(['resume_agent'], { enabled: true, maxParallel: 100, maxDepth: 50 })))
    .toEqual({ maxAgents: 64, maxDepth: 32, maxParallel: 8 });
});
it('does not admit children for a disabled policy or a read-only catalog', () => {
  for (const input of [prepared(['read_agent_transcript']), prepared(['spawn_agent'], { enabled: false, maxParallel: 4, maxDepth: 4 }),
    prepared(['spawn_agent'], { enabled: true, maxParallel: 4, maxDepth: 0 })]) {
    expect(nativeCoderTreeOptions(input)).toEqual({ maxAgents: 1, maxParallel: 1, maxDepth: 0 });
  }
});
