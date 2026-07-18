import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import { CoderRunner, normalizeMessagesForCache } from '../../runner.js';
import { resolveToolOutputPolicy } from '../../tool-output-policy.js';

class StubProvider implements ChatProvider {
  readonly name = 'stub';
  model = 'stub-1';
  setModel(model: string): void { this.model = model; }
  async *chat(_request: ChatRequest): AsyncIterable<ChatDelta> {
    yield { type: 'done' };
  }
}

function history(toolName: string, content: string): AgentMessage[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'legacy-call', name: toolName, input: {} }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: 'legacy-call', content }],
    },
  ];
}

function resultContent(messages: AgentMessage[]): {
  content: string;
  truncated?: boolean;
  originalSize?: number;
} {
  const block = messages[1]?.content[0];
  if (block?.type !== 'tool_result') throw new Error('expected tool_result');
  return block;
}

describe('resume tool-output policy', () => {
  it('bounds and spills historical authoritative output instead of bypassing context safety', () => {
    const raw = `AUTHORITATIVE-BEGIN\n${'x'.repeat(500)}\nAUTHORITATIVE-END`;
    const stored: string[] = [];
    const normalized = normalizeMessagesForCache(
      history('app_get_workflow', raw),
      80,
      new Set(['app_get_workflow']),
      (name) => ({ policy: resolveToolOutputPolicy(name), cap: 140 }),
      { put: (content) => { stored.push(content); return 'cafe00000001'; } },
    );

    const block = resultContent(normalized);
    expect(block.truncated).toBe(true);
    expect(block.originalSize).toBe(raw.length);
    expect(block.content.length).toBeLessThanOrEqual(140);
    expect(block.content).toContain('output_id=cafe00000001');
    expect(stored).toEqual([raw]);
  });

  it('uses a contiguous prefix for historical line-range results', () => {
    const raw = `FIRST-LINE\n${'m'.repeat(500)}\nTAIL-MUST-NOT-BE-SPLICED-IN`;
    const normalized = normalizeMessagesForCache(
      history('read_file', raw),
      220,
      undefined,
      (name) => ({ policy: resolveToolOutputPolicy(name), cap: 220 }),
      { put: () => 'cafe00000002' },
    );

    const block = resultContent(normalized);
    expect(block.content.length).toBeLessThanOrEqual(220);
    expect(block.content).toContain('FIRST-LINE');
    expect(block.content).toContain('output_id=cafe00000002');
    expect(block.content).not.toContain('TAIL-MUST-NOT-BE-SPLICED-IN');
  });

  it('does not create recovery-of-recovery ids for historical output pages', () => {
    let puts = 0;
    const normalized = normalizeMessagesForCache(
      history('get_tool_output', 'p'.repeat(500)),
      100,
      undefined,
      (name) => ({ policy: resolveToolOutputPolicy(name), cap: 100 }),
      { put: () => { puts += 1; return 'recursive'; } },
    );

    const block = resultContent(normalized);
    expect(block.truncated).toBe(true);
    expect(block.content.length).toBeLessThanOrEqual(100);
    expect(block.content).not.toContain('output_id=');
    expect(puts).toBe(0);
  });

  it('reuses an existing recovery id instead of storing a reduced preview again', () => {
    let puts = 0;
    const preview = `${'p'.repeat(220)}\n[reduced: middle omitted; use get_tool_output("cafe00000003")]`;
    const normalized = normalizeMessagesForCache(
      history('run_command', preview),
      120,
      undefined,
      (name) => ({ policy: resolveToolOutputPolicy(name), cap: 120 }),
      { put: () => { puts += 1; return 'cafe00000004'; } },
    );

    const block = resultContent(normalized);
    expect(block.content.length).toBeLessThanOrEqual(120);
    expect(block.content).toContain('cafe00000003');
    expect(block.content).not.toContain('cafe00000004');
    expect(puts).toBe(0);
  });

  it('preserves prior originalSize and recovery id when a truncated block is re-capped', () => {
    let puts = 0;
    const messages = history(
      'read_file',
      `${'q'.repeat(220)}\n[truncated: output_id=cafe00000005; original_chars=9000]`,
    );
    const oldBlock = messages[1]?.content[0];
    if (oldBlock?.type !== 'tool_result') throw new Error('expected tool_result');
    oldBlock.truncated = true;
    oldBlock.originalSize = 9_000;

    const normalized = normalizeMessagesForCache(
      messages,
      120,
      undefined,
      (name) => ({ policy: resolveToolOutputPolicy(name), cap: 120 }),
      { put: () => { puts += 1; return 'cafe00000006'; } },
    );

    const block = resultContent(normalized);
    expect(block.content.length).toBeLessThanOrEqual(120);
    expect(block.originalSize).toBe(9_000);
    expect(block.content).toContain('cafe00000005');
    expect(puts).toBe(0);
  });

  it('uses the real runner policy for a preserved dynamic tool absent from the registry', () => {
    const raw = `DYNAMIC-AUTHORITATIVE\n${'z'.repeat(500)}`;
    const stored: string[] = [];
    const runner = new CoderRunner({
      provider: new StubProvider(),
      registry: new ToolRegistry(),
      systemPrompt: 'test',
      initialMessages: history('app_get_workflow', raw),
      pushTimeCap: 80,
      preservedToolOutputCap: 140,
      preserveToolOutputNames: new Set(['app_get_workflow']),
      toolContext: {
        cwd: '/tmp',
        projectName: 'test',
        toolOutputStore: {
          put: (content: string) => { stored.push(content); return 'cafe00000007'; },
        } as never,
      },
    });

    const block = resultContent(runner.messages);
    expect(block.content.length).toBeLessThanOrEqual(140);
    expect(block.content).toContain('output_id=cafe00000007');
    expect(block.originalSize).toBe(raw.length);
    expect(stored).toEqual([raw]);
  });
});
