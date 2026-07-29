import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: string) =>
        key === 'chat:rightRail.preview' ? 'Preview' : (fallback ?? key),
    }),
  };
});

import { ChatRightRail } from '../ChatRightRail.js';

function render(previewAvailable: boolean, activePanelId: 'preview' | null = null): string {
  return renderToStaticMarkup(createElement(ChatRightRail, {
    sessionId: 'session-1',
    activePanelId,
    onSelectPanel: () => {},
    previewAvailable,
  }));
}

describe('ChatRightRail project preview', () => {
  it('adds Preview as an active right-rail panel when the project exposes it', () => {
    const html = render(true, 'preview');

    expect(html).toContain('aria-label="Preview"');
    expect(html).toContain('aria-pressed="true"');
  });

  it('does not expose Preview in sessions without a project preview', () => {
    expect(render(false)).not.toContain('aria-label="Preview"');
  });
});
