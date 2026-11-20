import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { dispatchTools } from '../executing-dispatch.js';

const toolContext = { cwd: process.cwd(), projectName: 'test' } as ToolContext;

function readTool(
  name: string,
  invoked: (input: Record<string, unknown>) => void,
): CoderTool {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: {} },
    source: 'native',
    mutates: false,
    executionClass: 'read',
    repeatPolicy: 'stable',
    handler: async (input) => {
      invoked(input as Record<string, unknown>);
      return { content: `${name} result` };
    },
  };
}

describe('dispatchTools — deterministic retrieval batch guard', () => {
  it('returns balanced non-error results while avoiding a redundant broad invocation', async () => {
    const invoked: string[] = [];
    const started: string[] = [];
    const registry = new ToolRegistry();
    registry.register(readTool('mcp__get_repo_map', () => invoked.push('map')));
    registry.register(readTool('mcp__search', () => invoked.push('search')));

    const result = await dispatchTools({
      toolUses: [
        { id: 'map', name: 'mcp__get_repo_map', input: {} },
        { id: 'search', name: 'mcp__search', input: { query: 'session expiry' } },
      ],
      retrievalBatch: { taskText: 'Onde a sessão expira?' },
      registry,
      toolContext,
      turn: 1,
      onToolCallStart: (id) => started.push(id),
    });

    expect(invoked).toEqual(['search']);
    expect(started).toEqual(['search']);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      toolUseId: 'map',
      isError: false,
      guardVerdict: {
        action: 'reuse',
        reason: 'targeted-search-over-broad-map',
        originToolUseId: 'search',
      },
    });
  });

  it('executes compatible greps once with their merged regex', async () => {
    const inputs: Record<string, unknown>[] = [];
    const registry = new ToolRegistry();
    registry.register(readTool('mcp__grep_code', (input) => inputs.push(input)));

    const result = await dispatchTools({
      toolUses: [
        { id: 'one', name: 'mcp__grep_code', input: { pattern: 'sessionTtl', max_results: 10 } },
        { id: 'two', name: 'mcp__grep_code', input: { pattern: 'expiresAt', max_results: 20 } },
      ],
      retrievalBatch: { taskText: 'Trace session expiry' },
      registry,
      toolContext,
      turn: 1,
    });

    expect(inputs).toEqual([{
      pattern: '(?:sessionTtl)|(?:expiresAt)',
      max_results: 30,
    }]);
    expect(result.results).toHaveLength(2);
    expect(result.results[1].guardVerdict).toMatchObject({
      action: 'reuse',
      reason: 'same-batch-grep-merge',
      originToolUseId: 'one',
    });
  });
});
