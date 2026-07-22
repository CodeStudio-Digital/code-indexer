import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenFile } from '../../../../state/workspace.js';
import { MarkdownView } from '../MarkdownView.js';

const file: OpenFile = {
  projectId: 7,
  path: 'CHANGELOG.md',
  content: '# Changelog',
  dirty: false,
  lastModified: null,
};

afterEach(() => vi.unstubAllGlobals());

describe('MarkdownView layout', () => {
  it('contains the absolute Monaco surface below the mode toolbar', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => key === 'mcp-ide:md-mode:CHANGELOG.md' ? 'edit' : null,
        setItem: vi.fn(),
      },
    });

    const html = renderToStaticMarkup(createElement(MarkdownView, { file }));

    expect(html).toContain('>Edit<');
    expect(html).toContain('>Preview<');
    expect(html).toContain('>Split<');
    const editorSurface = 'class="relative h-full min-w-0 min-h-0 overflow-hidden"';
    expect(html).toContain(editorSurface);
    expect(html.indexOf('>Split<')).toBeLessThan(html.indexOf(editorSurface));
  });

  it('renders a draggable persisted panel group in split mode', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => key === 'mcp-ide:md-mode:CHANGELOG.md' ? 'split' : null,
        setItem: vi.fn(),
      },
    });

    const html = renderToStaticMarkup(createElement(MarkdownView, { file }));

    expect(html).toContain('cursor-col-resize');
    expect(html).toContain('markdown-source');
    expect(html).toContain('markdown-preview');
  });
});
