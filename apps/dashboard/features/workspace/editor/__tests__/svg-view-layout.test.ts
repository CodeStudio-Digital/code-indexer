import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenFile } from '../../../../state/workspace.js';
import { SvgView } from '../SvgView.js';

import i18n from '../../../../i18n/index.js';
import { bootstrapTestI18n } from '../../../../i18n/test-bootstrap.js';

let previousLanguage: string;
beforeAll(async () => {
  await bootstrapTestI18n();
  previousLanguage = i18n.language;
  await i18n.changeLanguage('en');
});
afterAll(async () => { await i18n.changeLanguage(previousLanguage); });

const file: OpenFile = {
  projectId: 7,
  path: 'assets/logo.svg',
  content: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" /></svg>',
  dirty: false,
  lastModified: null,
};

afterEach(() => vi.unstubAllGlobals());

describe('SvgView layout', () => {
  it('offers editing, preview and a draggable persistent split', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => key === 'mcp-ide:svg-mode:assets/logo.svg' ? 'split' : null,
        setItem: vi.fn(),
      },
    });

    const html = renderToStaticMarkup(createElement(SvgView, { file }));

    expect(html).toContain('>Edit<');
    expect(html).toContain('>Preview<');
    expect(html).toContain('>Split<');
    expect(html).toContain('cursor-col-resize');
    expect(html).toContain('svg-source');
    expect(html).toContain('svg-preview');
  });
});
