/**
 * Pins the framework-agnostic surface of the Builder source-stamp module:
 * the postMessage guard and the React contribution shape (config splice
 * + files written + dev-only entry import). Runtime behaviour (the actual
 * DOM stamping) is exercised end-to-end in the live sandbox.
 */
import { describe, it, expect } from 'vitest';
import { isPreviewMessage } from '../protocol.js';
import { getSourceStampPlugin } from '../source-stamp/registry.js';

describe('isPreviewMessage', () => {
  it('accepts known mcp messages and rejects everything else', () => {
    expect(isPreviewMessage({ type: 'mcp:select', loc: 'a:1:1' })).toBe(true);
    expect(isPreviewMessage({ type: 'mcp:ready' })).toBe(true);
    expect(isPreviewMessage({ type: 'mcp:network', status: 500 })).toBe(true);
    expect(isPreviewMessage({ type: 'something-else' })).toBe(false);
    expect(isPreviewMessage(null)).toBe(false);
    expect(isPreviewMessage('mcp:select')).toBe(false);
  });
});

describe('getSourceStampPlugin', () => {
  it('returns a React plugin for react-ts and null for unsupported stacks', () => {
    expect(getSourceStampPlugin('react-ts')).not.toBeNull();
    expect(getSourceStampPlugin('vue-ts')).toBeNull();
    expect(getSourceStampPlugin('angular')).toBeNull();
  });

  it('React contribution wires the standalone stamp plugin + ships the inspector + dev-only entry import', () => {
    const c = getSourceStampPlugin('react-ts')!.contribution();
    // vite config splice: plugin-react (Fast Refresh) + the standalone stamp plugin.
    expect(c.vite.imports.join('\n')).toContain('@vitejs/plugin-react');
    expect(c.vite.imports.join('\n')).toContain('.mcp/vite-mcp-stamp.mjs');
    const exprs = c.vite.pluginExprs;
    expect(exprs).toContain('mcpStampVite()');
    expect(exprs).toContain('react()');
    // Stamp must run BEFORE plugin-react/oxc transforms the JSX away.
    expect(exprs.indexOf('mcpStampVite()')).toBeLessThan(exprs.indexOf('react()'));
    // It must NOT ride plugin-react's `babel` option — v6 transforms with oxc
    // and ignores it, which is the bug this fix addresses.
    expect(exprs.join('')).not.toContain('babel:');
    // files: babel stamp + standalone vite plugin + inspector
    const paths = c.files.map((f) => f.path).sort();
    expect(paths).toEqual(['.mcp/babel-mcp-stamp.cjs', '.mcp/vite-mcp-stamp.mjs', 'src/mcp-inspector.ts']);
    const inspector = c.files.find((f) => f.path === 'src/mcp-inspector.ts')!.contents;
    expect(inspector).toContain('initMcpConsoleBridge');
    expect(inspector).toContain('initMcpInspector');
    expect(inspector).toContain("type: \"mcp:ready\"");
    const babel = c.files.find((f) => f.path === '.mcp/babel-mcp-stamp.cjs')!.contents;
    expect(babel).toContain('data-mcp-loc');
    expect(babel).toContain('JSXOpeningElement');
    // standalone stamp plugin: dev-only (apply:'serve'), pre, runs the babel stamp.
    const viteStamp = c.files.find((f) => f.path === '.mcp/vite-mcp-stamp.mjs')!.contents;
    expect(viteStamp).toContain("enforce: 'pre'");
    expect(viteStamp).toContain("apply: 'serve'");
    expect(viteStamp).toContain('./babel-mcp-stamp.cjs');
    // entry: dev-only inspector import, double-quoted for shell-safe append
    expect(c.entry.file).toBe('src/main.tsx');
    expect(c.entry.importLine).toContain('import.meta.env.DEV');
    expect(c.entry.importLine).toContain('"./mcp-inspector"');
    expect(c.entry.importLine).not.toContain("'");
  });
});
