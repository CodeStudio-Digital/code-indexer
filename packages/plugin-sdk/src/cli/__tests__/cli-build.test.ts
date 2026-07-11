import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
const PLUGIN_TS = `import runtimeBuiltin from './runtime.cjs';
export default {
  tools: [
    { name: 'echo', description: 'Echo', parameters: { type: 'object', properties: { text: { type: 'string' } } }, mutates: false, handler: async (a) => ({ content: a.builtin ? runtimeBuiltin() : String(a.text ?? '') }) },
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
  // Defer the builtin require until the handler runs. The bundle can import
  // successfully without a require shim; invoking the handler is the
  // regression that used to throw `Dynamic require of "node:stream" is not supported`.
  writeFileSync(
    join(dir, 'src', 'runtime.cjs'),
    `module.exports = () => require('node:stream').Readable.name;\n`,
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('buildPlugin', () => {
  it('bundles src/plugin.ts and extracts a handler-free .app.json', async () => {
    const r = await buildPlugin(dir);
    expect(existsSync(r.bundle)).toBe(true);
    expect(r.tools).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, 'dist', 'package.json'), 'utf8'))).toEqual({
      type: 'module',
      mcpPluginRuntimeFormat: 4,
    });

    const app = JSON.parse(readFileSync(r.appJson, 'utf8'));
    expect(app.worker).toBe('./dist/plugin.js');
    expect(app.tools[0].name).toBe('echo');
    expect(app.tools[0].mutates).toBe(false);
    expect(app.tools[0].handler).toBeUndefined();
    expect(app.commands[0].id).toBe('c');
  });

  it('supports deferred CommonJS builtin requires from a clean ESM process', async () => {
    const r = await buildPlugin(dir);
    const probe = [
      `import { pathToFileURL } from 'node:url';`,
      `const mod = await import(pathToFileURL(process.argv[1]).href);`,
      `const result = await mod.default.tools[0].handler({ builtin: true }, {});`,
      `console.log(result.content);`,
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', probe, r.bundle], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
    });

    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe('Readable');
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

  it('builds without UI templates exactly as before (uiFiles empty)', async () => {
    const r = await buildPlugin(dir);
    expect(r.uiFiles).toEqual([]);
  });
});

describe('buildPlugin — UI templates', () => {
  beforeEach(() => {
    mkdirSync(join(dir, 'ui', 'src'), { recursive: true });
    // Two modules so the bundle step is exercised; the literal "</script>"
    // string must come out escaped or the inline tag closes early.
    writeFileSync(
      join(dir, 'ui', 'src', 'extra.ts'),
      `export const marker = 'FROM_EXTRA_MODULE';\n`,
    );
    writeFileSync(
      join(dir, 'ui', 'src', 'panel.ts'),
      `import { marker } from './extra.js';\nconst evil = '</script>';\ndocument.title = marker + evil;\n`,
    );
    writeFileSync(join(dir, 'ui', 'panel.css'), `.mcp-x { color: red; }\n`);
    writeFileSync(
      join(dir, 'ui', 'panel.template.html'),
      [
        '<!doctype html><html><head>',
        '<link rel="stylesheet" href="./panel.css">',
        '<link rel="icon" href="https://example.com/favicon.ico">',
        '</head><body>',
        '<script src="./src/panel.ts"></script>',
        '<script src="https://cdn.example.com/lib.js"></script>',
        '</body></html>',
      ].join('\n'),
    );
  });

  it('inlines relative script+css refs, leaves absolute refs, escapes </script>', async () => {
    const r = await buildPlugin(dir);
    expect(r.uiFiles).toHaveLength(1);
    const outPath = join(dir, 'ui', 'panel.html');
    expect(r.uiFiles[0]).toBe(outPath);
    const html = readFileSync(outPath, 'utf8');

    // Bundled code from both modules is present, inline.
    expect(html).toContain('FROM_EXTRA_MODULE');
    expect(html).not.toMatch(/src\s*=\s*["']\.\/src\/panel\.ts["']/);
    expect(html).not.toMatch(/href\s*=\s*["']\.\/panel\.css["']/);
    expect(html).toContain('.mcp-x');

    // Absolute refs untouched.
    expect(html).toContain('https://cdn.example.com/lib.js');
    expect(html).toContain('https://example.com/favicon.ico');

    // The literal </script> inside a string is escaped (no early close).
    expect(html).toContain('<\\/script>');
  });

  it('validate hints at running build when only the template exists', async () => {
    await buildPlugin(dir); // emits .app.json
    const app = JSON.parse(readFileSync(join(dir, '.app.json'), 'utf8'));
    app.toolWindows = [{ id: 'p', title: 'P', side: 'right', entry: 'ui/panel.html' }];
    writeFileSync(join(dir, '.app.json'), JSON.stringify(app));
    rmSync(join(dir, 'ui', 'panel.html'));
    const issues = await validatePlugin(dir);
    expect(issues.some((i) => i.message.includes('run build to inline the template'))).toBe(true);
  });

  it('fails loudly when a relative ref is missing', async () => {
    writeFileSync(
      join(dir, 'ui', 'panel.template.html'),
      '<html><head></head><body><script src="./src/nope.ts"></script></body></html>',
    );
    await expect(buildPlugin(dir)).rejects.toThrow(/missing script \.\/src\/nope\.ts/);
  });
});
