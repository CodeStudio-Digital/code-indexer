/**
 * Guards the Builder-mode "linchpin": `renderViteConfig` is the single
 * source of truth for the sandbox `vite.config.ts` and is regenerated
 * from scratch on every dev-server restart/resume. The source-stamp
 * contribution (which powers element selection) MUST be re-applied on
 * each regeneration — otherwise selection silently dies after the first
 * restart.
 *
 * Two invariants:
 *   1. Without a stamp, the output is byte-identical to the legacy config
 *      (no `plugins` key, no extra imports) — non-Builder sandboxes are
 *      untouched.
 *   2. With a stamp, the imports are spliced below the `vite` import and
 *      the plugin expressions populate a `plugins: [...]` array.
 */
import { describe, it, expect } from 'vitest';
import { renderViteConfig } from '../vite-scaffolder-base.js';

const BASE_OPTS = {
  base: '/preview/42/',
  hmrPath: '/preview/42/@vite/hmr',
  devPort: 5173,
};

describe('renderViteConfig — stamp injection', () => {
  it('produces the legacy config (no plugins, no extra imports) when no stamp is given', () => {
    const cfg = renderViteConfig(BASE_OPTS);
    expect(cfg).toContain(`import { defineConfig } from 'vite';`);
    expect(cfg).toContain(`base: "/preview/42/"`);
    // No stamp → no plugins array and no plugin imports.
    expect(cfg).not.toContain('plugins:');
    // The vite import is immediately followed by a blank line + defineConfig.
    expect(cfg).toContain(`import { defineConfig } from 'vite';\n\nexport default defineConfig({`);
  });

  it('splices stamp imports below the vite import and a plugins array into defineConfig', () => {
    const cfg = renderViteConfig({
      ...BASE_OPTS,
      stamp: {
        imports: [`import mcpStamp from './.mcp/vite-mcp-stamp.js';`],
        pluginExprs: ['mcpStamp()'],
      },
    });
    expect(cfg).toContain(`import mcpStamp from './.mcp/vite-mcp-stamp.js';`);
    expect(cfg).toContain('plugins: [mcpStamp()],');
    // Import lands directly under the vite import (before defineConfig).
    const importIdx = cfg.indexOf(`import mcpStamp`);
    const defineIdx = cfg.indexOf('export default defineConfig(');
    expect(importIdx).toBeGreaterThan(-1);
    expect(importIdx).toBeLessThan(defineIdx);
    // plugins line sits above the server block.
    expect(cfg.indexOf('plugins: [')).toBeLessThan(cfg.indexOf('server: {'));
  });

  it('joins multiple plugin expressions and imports', () => {
    const cfg = renderViteConfig({
      ...BASE_OPTS,
      stamp: {
        imports: [`import a from 'a';`, `import b from 'b';`],
        pluginExprs: ['a()', 'b({ dev: true })'],
      },
    });
    expect(cfg).toContain('plugins: [a(), b({ dev: true })],');
    expect(cfg).toContain(`import a from 'a';`);
    expect(cfg).toContain(`import b from 'b';`);
  });

  it('emits a resolve.alias block from stamp.resolveAlias (raw expression values)', () => {
    const cfg = renderViteConfig({
      ...BASE_OPTS,
      stamp: {
        imports: [`import { fileURLToPath as f } from 'node:url';`],
        pluginExprs: [],
        resolveAlias: { '@': `f(new URL('./src', import.meta.url))` },
      },
    });
    expect(cfg).toContain('resolve: {');
    expect(cfg).toContain('alias: {');
    // Key is JSON-quoted, value is the raw expression (not quoted).
    expect(cfg).toContain(`"@": f(new URL('./src', import.meta.url)),`);
    // No alias block when resolveAlias is absent.
    expect(renderViteConfig(BASE_OPTS)).not.toContain('resolve: {');
  });

  it('re-rendering with the same stamp is deterministic (restart survival)', () => {
    const stamp = {
      imports: [`import mcpStamp from './.mcp/vite-mcp-stamp.js';`],
      pluginExprs: ['mcpStamp()'],
    };
    const first = renderViteConfig({ ...BASE_OPTS, stamp });
    const second = renderViteConfig({ ...BASE_OPTS, stamp });
    expect(first).toBe(second);
  });
});
