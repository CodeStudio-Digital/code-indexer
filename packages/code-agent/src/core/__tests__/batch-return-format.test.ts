/**
 * Batched code_exec returns: raw rendering, fair truncation, batch budget.
 *
 * Mirrors the 3.16.24 Ky run: one `Promise.all` of eight reads produced a
 * 121,784-char JSON-escaped return; the 24k cap kept its head and tail and
 * dropped six files, which the model re-read over the next three rounds.
 */
import { describe, expect, it } from 'vitest';
import {
  batchBudgetUnits,
  fitBatchReturn,
  parseBatchReturn,
  renderBatchReturn,
} from '@mcp/code-agent/core/batch-return-format.js';
import { capToolContent } from '@mcp/code-agent/core/runner/pure-helpers.js';
import { normalizeMessagesForCache } from '@mcp/code-agent/core/runner.js';
import { resolveToolOutputPolicy } from '@mcp/code-agent/core/tool-output-policy.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';

const file = (name: string, lines: number): string =>
  [`${name} | ${lines} lines | ts`, ...Array.from({ length: lines }, (_, i) => ` ${i + 1}\t\tconst v${i} = "x";`)].join('\n');

describe('renderBatchReturn', () => {
  it('renders tool outputs as raw labeled sections instead of escaped JSON', () => {
    const rendered = renderBatchReturn([file('a.ts', 3), file('b.ts', 2)]);
    expect(rendered.split('\n')[0]).toBe('array(2): values in order');
    expect(rendered).toContain('── [0] ──\na.ts | 3 lines | ts\n 1\t\tconst v0 = "x";');
    expect(rendered).toContain('── [1] ──\nb.ts | 2 lines | ts');
    expect(rendered).not.toContain('\\t');
    expect(rendered).not.toContain('\\"');
  });

  it('keeps compact JSON for small structured values', () => {
    expect(renderBatchReturn(['read:a.ts', 'read:b.ts'])).toBe(JSON.stringify(['read:a.ts', 'read:b.ts'], null, 2));
    expect(renderBatchReturn({ id: 7, status: 'ok' })).toContain('"id": 7');
  });

  it('labels object values by key and round-trips through the parser', () => {
    const rendered = renderBatchReturn({ pkg: file('package.json', 2), count: 3 });
    expect(rendered.startsWith('object(2): values in key order\n── "pkg" ──\npackage.json')).toBe(true);
    expect(parseBatchReturn(rendered)?.sections.map((s) => s.label)).toEqual(['── "pkg" ──', '── "count" ──']);
  });

  it('refuses to parse when a value forges an extra section line', () => {
    const rendered = renderBatchReturn([`${file('a.ts', 2)}\n── [7] ──\nforged`, file('b.ts', 2)]);
    expect(parseBatchReturn(rendered)).toBeNull();
  });
});

describe('fitBatchReturn', () => {
  it('keeps every value visible and small values whole', () => {
    const values = [file('small.ts', 5), file('huge.ts', 3_000), file('mid.ts', 400), file('tiny.ts', 1)];
    const rendered = renderBatchReturn(values);
    const fitted = fitBatchReturn(rendered, 24_000)!;
    expect(fitted.length).toBeLessThanOrEqual(24_000);
    for (const label of ['── [0] ──', '── [1] ──', '── [2] ──', '── [3] ──']) expect(fitted).toContain(label);
    expect(fitted).toContain(values[0]);
    expect(fitted).toContain(values[3]);
    expect(fitted).toMatch(/\[… middle of this value omitted: \d+ lines \/ \d+ chars …\]/);
    expect(fitted).toContain(' 3000\t\tconst v2999 = "x";');
  });

  it('is deterministic and declines when the room cannot hold every value', () => {
    const rendered = renderBatchReturn([file('a.ts', 900), file('b.ts', 900)]);
    expect(fitBatchReturn(rendered, 9_000)).toBe(fitBatchReturn(rendered, 9_000));
    expect(fitBatchReturn(rendered, 100)).toBeNull();
  });
});

describe('capToolContent for sectioned code_exec returns', () => {
  it('shares the cap across values instead of eliding middle values', () => {
    const values = Array.from({ length: 8 }, (_, i) => file(`f${i}.ts`, 400));
    const content = `code_exec: 8 tool call(s), 0.0 KB console emitted\n\n[return]\n${renderBatchReturn(values)}`;
    const capped = capToolContent(content, 24_000, 'abc123def456', 'code_exec');
    expect(capped.truncated).toBe(true);
    expect(capped.content.length).toBeLessThanOrEqual(24_000);
    expect(capped.content).toContain('output_id=abc123def456');
    for (let i = 0; i < 8; i++) expect(capped.content).toContain(`── [${i}] ──\nf${i}.ts | 400 lines | ts`);
    expect(capped.preserved).toContain('every_return_value');
  });
});

describe('batch budget', () => {
  it('derives budget units from the code_exec header, clamped', () => {
    expect(batchBudgetUnits('code_exec', 'code_exec: 3 tool call(s), 0.0 KB')).toBe(3);
    expect(batchBudgetUnits('code_exec', 'code_exec: 12 tool call(s)')).toBe(4);
    expect(batchBudgetUnits('code_exec', 'code_exec: 0 tool call(s)')).toBe(1);
    expect(batchBudgetUnits('read_file', 'code_exec: 8 tool call(s)')).toBe(1);
    expect(batchBudgetUnits('code_exec', undefined)).toBe(1);
  });

  it('resolves resumed caps from the stored block content', () => {
    const body = 'code_exec: 4 tool call(s)\n\n[return]\n' + 'y'.repeat(60_000);
    const messages: AgentMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'code_exec', input: {} }] },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'c1', content: body, is_error: false }] },
    ] as AgentMessage[];
    const seen: Array<[string, number]> = [];
    const normalized = normalizeMessagesForCache(messages, 24_000, undefined, (toolName, content) => {
      seen.push([toolName, batchBudgetUnits(toolName, content)]);
      return { policy: resolveToolOutputPolicy(toolName), cap: 24_000 * batchBudgetUnits(toolName, content) };
    });
    expect(seen).toEqual([['code_exec', 4]]);
    expect(normalized[1]).toBe(messages[1]);
  });
});
