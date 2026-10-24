import { describe, expect, it } from 'vitest';
import { getToolOutput, renderOutputPage } from '../tool-output.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

describe('get_tool_output pagination contract', () => {
  it('awaits durable reads and never returns a page after cancellation', async () => {
    const controller = new AbortController();
    let release!: (content: string) => void;
    const content = new Promise<string>(resolve => { release = resolve; });
    const result = getToolOutput.handler({ output_id: 'a'.repeat(64) }, {
      signal: controller.signal, toolOutputStore: { get: () => content },
    } as unknown as ToolContext);
    controller.abort(new Error('cancelled')); release('late content');
    await expect(result).rejects.toThrow('cancelled');
  });
  it('rejects invented non-hex output ids before consulting the store', async () => {
    let reads = 0;
    const ctx = {
      cwd: process.cwd(),
      projectName: 'test',
      toolOutputStore: { get: () => { reads++; return null; } },
    } as unknown as ToolContext;

    const result = await getToolOutput.handler({ output_id: 'nonexistent' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('never invent a placeholder');
    expect(reads).toBe(0);
    expect(getToolOutput.parameters.properties?.output_id).toMatchObject({
      pattern: '^[a-f0-9]{6,64}$',
    });
  });

  it('budgets the footer inside the effective inline cap', async () => {
    const content = '0123456789'.repeat(100);
    const ctx = {
      cwd: process.cwd(),
      projectName: 'test',
      toolOutputInlineCap: 240,
      toolOutputStore: { get: () => content },
    } as unknown as ToolContext;
    const result = await getToolOutput.handler({ output_id: 'abc123', limit: 500 }, ctx);
    expect(result.content.length).toBeLessThanOrEqual(240);
    expect(result.content).toContain('page limited to inline budget');
    expect(result.content).toContain('get_tool_output("abc123", offset=');
    expect(result.content).not.toContain('output_id=');
  });

  it('defaults the requested page to the active session cap', async () => {
    const content = 'x'.repeat(2_000);
    const ctx = {
      cwd: process.cwd(),
      projectName: 'test',
      toolOutputInlineCap: 180,
      toolOutputStore: { get: () => content },
    } as unknown as ToolContext;

    const result = await getToolOutput.handler({ output_id: 'abc123' }, ctx);
    expect(result.content.length).toBeLessThanOrEqual(180);
    expect(result.content).toContain('page limited to inline budget');
    expect(result.content).toContain('offset=');
  });

  it('returns contiguous, non-overlapping pages with a truthful cursor', () => {
    const content = Array.from({ length: 800 }, (_, i) => String(i % 10)).join('');
    const first = renderOutputPage({ content, id: 'feed01', offset: 0, requestedLimit: 300, inlineCap: 220 });
    const match = first.match(/offset=(\d+)/);
    expect(match).not.toBeNull();
    const next = Number(match![1]);
    const payload = first.slice(0, first.indexOf('\n\n[chars'));
    expect(payload).toBe(content.slice(0, next));
    const second = renderOutputPage({ content, id: 'feed01', offset: next, requestedLimit: 300, inlineCap: 220 });
    const secondPayload = second.slice(0, second.indexOf('\n\n[chars'));
    expect(secondPayload).toBe(content.slice(next, next + secondPayload.length));
    expect(first.length).toBeLessThanOrEqual(220);
    expect(second.length).toBeLessThanOrEqual(220);
  });

  it('never exceeds the cap when footer digit widths change', () => {
    const content = 'x'.repeat(20_000);
    const page = renderOutputPage({
      content,
      id: 'abcdef1234567890',
      offset: 149,
      requestedLimit: 20_000,
      inlineCap: 10_000,
    });
    expect(page.length).toBeLessThanOrEqual(10_000);
    expect(page).toContain('get_tool_output("abcdef1234567890", offset=');
  });

  it('never splits a Unicode surrogate pair at a page boundary', () => {
    const content = 'A😀BC';
    const first = renderOutputPage({
      content,
      id: 'unicode1',
      offset: 0,
      requestedLimit: 2,
      inlineCap: 200,
    });
    const firstPayload = first.slice(0, first.indexOf('\n\n[chars'));
    const next = Number(first.match(/offset=(\d+)/)?.[1]);
    const second = renderOutputPage({
      content,
      id: 'unicode1',
      offset: next,
      requestedLimit: 2,
      inlineCap: 200,
    });
    const secondPayload = second.slice(0, second.indexOf('\n\n[chars'));

    expect(firstPayload).toBe('A');
    expect(secondPayload).toBe('😀');
    expect(firstPayload + secondPayload).not.toContain('�');
  });

  it('makes progress when limit=1 starts on an astral character', () => {
    const page = renderOutputPage({
      content: '😀B', id: 'unicode2', offset: 0, requestedLimit: 1, inlineCap: 200,
    });
    expect(page.slice(0, page.indexOf('\n\n[chars'))).toBe('😀');
    expect(page).toContain('offset=2');
  });

  it('keeps even the compact tiny-cap fallback inside its ceiling', () => {
    const page = renderOutputPage({
      content: 'x'.repeat(38), id: 'tiny001', offset: 9, requestedLimit: 30, inlineCap: 26,
    });
    expect(page.length).toBeLessThanOrEqual(26);
  });
});
