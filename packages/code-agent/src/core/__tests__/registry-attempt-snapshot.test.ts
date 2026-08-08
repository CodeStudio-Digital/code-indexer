import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { CoderTool } from '../tool.js';

function tool(name: string): CoderTool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    source: 'native',
    handler: async () => ({ content: 'ok' }),
  };
}

describe('ToolRegistry attempt snapshot', () => {
  it('allows composition before launch and rejects late membership changes', () => {
    const registry = new ToolRegistry();
    registry.register(tool('read_file'));
    registry.filterInPlace((candidate) => candidate.name === 'read_file');
    registry.seal();

    expect(registry.isSealed).toBe(true);
    expect(registry.list().map((candidate) => candidate.name)).toEqual(['read_file']);
    expect(() => registry.register(tool('late_mcp'))).toThrow(/successor attempt/);
    expect(() => registry.filterInPlace(() => true)).toThrow(/before launch/);
  });

  it('keeps invocation available after the membership snapshot is sealed', async () => {
    const registry = new ToolRegistry();
    registry.register(tool('read_file'));
    registry.seal();

    const result = await registry.invoke('read_file', {}, {
      cwd: '.',
      projectName: 'test',
    });
    expect(result).toMatchObject({ content: 'ok' });
  });
});
