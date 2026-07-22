import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenFile } from '../../../../state/workspace.js';
import { HtmlView } from '../HtmlView.js';

const file: OpenFile = {
  projectId: 7,
  path: 'site/index.html',
  content: '<!doctype html><html><body><a href="about.html">About</a></body></html>',
  dirty: false,
  lastModified: null,
};

afterEach(() => vi.unstubAllGlobals());

describe('HtmlView layout', () => {
  it('offers safe navigation and a draggable persisted split', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => key === 'mcp-ide:html-mode:site/index.html' ? 'split' : null,
        setItem: vi.fn(),
      },
    });

    const html = renderToStaticMarkup(createElement(HtmlView, { file }));

    expect(html).toContain('>Edit<');
    expect(html).toContain('>Preview<');
    expect(html).toContain('>Split<');
    expect(html).toContain('>Home<');
    expect(html).toContain('Scripts off');
    expect(html).toContain('cursor-col-resize');
    expect(html).toContain('html-source');
    expect(html).toContain('html-preview');
    expect(html).toContain('<iframe');
    expect(html).toContain('sandbox=""');
  });
});
