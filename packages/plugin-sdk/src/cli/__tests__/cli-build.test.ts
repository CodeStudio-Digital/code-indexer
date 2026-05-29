import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlugin } from '../build.js';
import { validatePlugin } from '../validate.js';

let dir: string;

const PLUGIN_JSON = JSON.stringify({
  name: 'fixture-plugin',
  version: '1.0.0',
  description: 'fixture',
  author: { name: 'T' },
  apps: './.app.json',
});

// Inline module (no SDK import) keeps the test independent of esbuild's
// node_modules resolution from a temp dir — it exercises bundle + extract.
const PLUGIN_TS = `export default {
  tools: [
    { name: 'echo', description: 'Echo', parameters: { type: 'object', properties: { text: { type: 'string' } } }, mutates: false, handler: async (a) => ({ content: String(a.text ?? '') }) },
  ],
  toolWindows: [],
  commands: [{ id: 'c', label: 'C' }],
  themes: [],
};
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-plugin-build-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), PLUGIN_JSON);
  writeFileSync(join(dir, 'src', 'plugin.ts'), PLUGIN_TS);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('buildPlugin', () => {
  it('bundles src/plugin.ts and extracts a handler-free .app.json', async () => {
    const r = await buildPlugin(dir);
    expect(existsSync(r.bundle)).toBe(true);
    expect(r.tools).toBe(1);

    const app = JSON.parse(readFileSync(r.appJson, 'utf8'));
    expect(app.worker).toBe('./dist/plugin.js');
    expect(app.tools[0].name).toBe('echo');
    expect(app.tools[0].mutates).toBe(false);
    expect(app.tools[0].handler).toBeUndefined();
    expect(app.commands[0].id).toBe('c');
  });

  it('validatePlugin passes on the built dir', async () => {
    await buildPlugin(dir);
    expect(await validatePlugin(dir)).toEqual([]);
  });

  it('validatePlugin flags an invalid manifest', async () => {
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({ name: 'Bad_Name', version: 'nope', description: 'd', author: { name: 'T' } }),
    );
    expect((await validatePlugin(dir)).length).toBeGreaterThan(0);
  });
});
