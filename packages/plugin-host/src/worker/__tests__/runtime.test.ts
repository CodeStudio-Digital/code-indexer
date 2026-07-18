import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginTools, invokePluginTool } from '../runtime.js';
import { buildSandboxContext } from '../sandbox-ctx.js';

let dir: string;
let bundle: string;

const SAMPLE = `export default {
  tools: [
    { name: 'echo', description: 'e', parameters: {}, handler: async (args) => ({
      content: 'echo:' + args.text,
      sourceTruncations: [{ technique: 'plugin-page-limit', inputSize: 2, outputSize: 1, unit: 'items', recoverable: true }],
    }) },
    { name: 'boom', description: 'b', parameters: {}, handler: async () => { throw new Error('kaboom'); } },
  ],
  toolWindows: [], commands: [], themes: [],
};
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-plugin-rt-'));
  bundle = join(dir, 'plugin.mjs');
  writeFileSync(bundle, SAMPLE);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ctx = buildSandboxContext({
  projectName: 'demo',
  cwd: '/tmp',
  log: () => {},
  hostInvoke: async () => null,
});

describe('plugin worker runtime', () => {
  it('loads and dispatches a tool handler', async () => {
    const map = await loadPluginTools([{ namespace: 'hello', file: bundle }]);
    expect(map.size).toBe(2);
    const r = await invokePluginTool(map, 'hello', 'echo', { text: 'hi' }, ctx);
    expect(r.content).toBe('echo:hi');
    expect(r.isError).toBeUndefined();
    expect(r.sourceTruncations).toEqual([{
      technique: 'plugin-page-limit',
      inputSize: 2,
      outputSize: 1,
      unit: 'items',
      recoverable: true,
    }]);
  });

  it('returns an error result for an unknown tool', async () => {
    const map = await loadPluginTools([{ namespace: 'hello', file: bundle }]);
    const r = await invokePluginTool(map, 'hello', 'nope', {}, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not found/);
  });

  it('captures a thrown handler error', async () => {
    const map = await loadPluginTools([{ namespace: 'hello', file: bundle }]);
    const r = await invokePluginTool(map, 'hello', 'boom', {}, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/kaboom/);
  });
});
