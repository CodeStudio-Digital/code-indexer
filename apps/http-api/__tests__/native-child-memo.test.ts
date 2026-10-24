import { expect, it } from 'vitest';
import { SubagentCollector } from '@mcp/code-agent/tools/subagent-collector.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { NativeChildMemo } from '../workers/native-child-memo.js';
import type { BufferedEvent } from '../coder-bus.js';

it('collects a memo only after its confirmed tool result and ignores duplicate delivery', async () => {
  const collector = new SubagentCollector(), memo = new NativeChildMemo(collector);
  const result = await memo.tool.handler({ text: 'Preserve the settings', kind: 'warning' }, {
    runtimeGeneration: 'rust_v1', subagentCollector: collector,
  } as ToolContext);
  expect(collector.snapshot().memos).toEqual([]);
  const event = { event: 'tool_call_result', data: { id: 'owned-tool', name: 'record_memo', result } } as BufferedEvent;
  memo.accept(event); memo.accept(event);
  expect(collector.snapshot().memos).toHaveLength(1);
  expect(collector.snapshot().memos[0]).toMatchObject({ text: 'Preserve the settings', kind: 'warning' });
});

it('rejects foreign collectors and excessive text without issuing any memo', async () => {
  const collector = new SubagentCollector(), memo = new NativeChildMemo(collector);
  expect((await memo.tool.handler({ text: 'x' }, {} as ToolContext)).isError).toBe(true);
  const context = { runtimeGeneration: 'rust_v1', subagentCollector: collector } as ToolContext;
  expect((await memo.tool.handler({ text: 'x'.repeat(301) }, context)).isError).toBe(true);
  for (let index = 0; index < 50; index++) expect((await memo.tool.handler({ text: String(index) }, context)).structuredData).toBeTruthy();
  expect((await memo.tool.handler({ text: 'overflow' }, context)).content).toContain('dropped');
  expect(collector.snapshot().memos).toEqual([]);
});
