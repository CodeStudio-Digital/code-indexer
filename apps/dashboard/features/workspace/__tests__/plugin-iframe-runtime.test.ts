import { describe, expect, it } from 'vitest';
import { injectIntoHtml } from '../plugin-iframe-runtime.js';
import { PLUGIN_UI_KIT_CSS } from '../plugin-ui-kit/index.js';
import { KIT } from '@mcp/plugin-sdk/ui/classes.js';

const CTX = { namespace: 'test', locale: 'en' };
const TOKENS = { '--background': '#fff' };

describe('injectIntoHtml', () => {
  it('injects the UI kit right after <head> opens, before the author style', () => {
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><style>.author{color:red}</style></head><body></body></html>';
    const out = injectIntoHtml(html, CTX, TOKENS);
    const headAt = out.indexOf('<head>');
    const kitAt = out.indexOf('id="mcp-ui-kit"');
    const authorAt = out.indexOf('.author');
    expect(kitAt).toBeGreaterThan(headAt);
    expect(kitAt).toBeLessThan(authorAt);
  });

  it('keeps context + theme + shim before </head>, after the author style', () => {
    const html = '<html><head><style>.author{}</style></head><body></body></html>';
    const out = injectIntoHtml(html, CTX, TOKENS);
    const authorAt = out.indexOf('.author');
    const ctxAt = out.indexOf('__pluginContext');
    const shimAt = out.indexOf('window.mcp =');
    const headCloseAt = out.indexOf('</head>');
    expect(ctxAt).toBeGreaterThan(authorAt);
    expect(shimAt).toBeGreaterThan(ctxAt);
    expect(headCloseAt).toBeGreaterThan(shimAt);
  });

  it('handles a <head> with attributes', () => {
    const html = '<html><head lang="en"><style>.a{}</style></head><body></body></html>';
    const out = injectIntoHtml(html, CTX, TOKENS);
    expect(out.indexOf('id="mcp-ui-kit"')).toBeGreaterThan(out.indexOf('<head lang="en">'));
    expect(out.indexOf('id="mcp-ui-kit"')).toBeLessThan(out.indexOf('.a{'));
  });

  it('without a <head>: shim first, then kit, then the original markup', () => {
    const out = injectIntoHtml('<div id="root">hi</div>', CTX, TOKENS);
    const ctxAt = out.indexOf('__pluginContext');
    const kitAt = out.indexOf('id="mcp-ui-kit"');
    const bodyAt = out.indexOf('<div id="root">');
    expect(ctxAt).toBeGreaterThanOrEqual(0);
    expect(ctxAt).toBeLessThan(kitAt);
    expect(kitAt).toBeLessThan(bodyAt);
  });
});

/** Collect top-level CSS selectors (at-rules included; nested blocks skipped). */
function topLevelSelectors(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of css) {
    if (ch === '{') {
      if (depth === 0) {
        const sel = buf.trim();
        if (sel.startsWith('@')) out.push(sel);
        else out.push(...sel.split(',').map((s) => s.trim()).filter(Boolean));
      }
      depth++;
      buf = '';
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      buf = '';
    } else if (depth === 0) {
      buf += ch;
    }
  }
  return out;
}

describe('PLUGIN_UI_KIT_CSS hygiene', () => {
  it('every selector is namespaced under .mcp- (no bare element selectors)', () => {
    const selectors = topLevelSelectors(PLUGIN_UI_KIT_CSS);
    expect(selectors.length).toBeGreaterThan(30);
    const offenders = selectors.filter(
      (s) => !s.startsWith('.mcp-') && !s.startsWith('@keyframes mcp-'),
    );
    expect(offenders).toEqual([]);
  });

  it('has no leftover unsupported at-rules (only @keyframes)', () => {
    const atRules = topLevelSelectors(PLUGIN_UI_KIT_CSS).filter((s) => s.startsWith('@'));
    for (const rule of atRules) expect(rule).toMatch(/^@keyframes mcp-/);
  });

  it('ships the enriched data-layer primitives', () => {
    for (const cls of [
      '.mcp-dtable',
      '.mcp-status',
      '.mcp-shell',
      '.mcp-rail',
      '.mcp-nav',
      '.mcp-page-head',
      '.mcp-stat',
      '.mcp-state',
    ]) {
      expect(PLUGIN_UI_KIT_CSS).toContain(`${cls} `);
    }
  });
});

/**
 * Cross-package contract guard: the SDK's `KIT` class-name constants are only
 * the NAMES — the CSS bodies live solely in the host kit, injected at runtime.
 * If the SDK references a class the host doesn't ship, plugins built against it
 * render unstyled. This asserts every constant resolves to a real kit rule.
 */
describe('SDK KIT class names ⊆ host kit', () => {
  it('every @mcp/plugin-sdk/ui KIT constant has a matching .mcp-* rule', () => {
    const offenders = Object.values(KIT).filter(
      (cls) => !new RegExp(`\\.${cls}(?![\\w-])`).test(PLUGIN_UI_KIT_CSS),
    );
    expect(offenders).toEqual([]);
  });
});
