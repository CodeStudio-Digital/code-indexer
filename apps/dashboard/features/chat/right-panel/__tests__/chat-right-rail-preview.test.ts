import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RightPanelId } from '../types.js';

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string, options?: { count?: number }) =>
    options?.count ? `${key}: ${options.count}` : key }),
}));
import { ChatRightRail } from '../ChatRightRail.js';

function render(activePanelId: RightPanelId | null = null, extras = {}) {
  return renderToStaticMarkup(createElement(ChatRightRail, {
    sessionId: 'session-1', activePanelId, onSelectPanel: () => {}, ...extras,
  }));
}

describe('ChatRightRail navigation', () => {
  it('keeps four primary entries and configuration, with specialist tools in More', () => {
    const html = render(null, { previewAvailable: true });
    for (const name of ['state', 'context', 'changes', 'more', 'config']) {
      expect(html).toContain(`aria-label="rightRail.${name}"`);
    }
    expect(html.match(/<button /g)).toHaveLength(5);
    expect(html).not.toContain('aria-label="rightRail.preview"');
  });
  it.each(['plans', 'chapters'] as const)('recognizes legacy grouped panel %s', (id) => {
    const html = render(id);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });
  it('offers a subagents shortcut only when there is activity or history', () => {
    expect(render()).not.toContain('aria-label="rightRail.subagents"');
    expect(render(null, { subagentsAvailable: true })).toContain('aria-label="rightRail.subagents"');
    expect(render(null, { subagentsAvailable: true, activeSubagentCount: 2 })).toContain('aria-label="rightRail.activeSubagents: 2"');
  });
  it('keeps an opened empty subagents panel closable and labels pending hunks', () => {
    expect(render('subagents')).toContain('aria-label="rightRail.subagents"');
    expect(render(null, { pendingSnapshots: 27 })).toContain('aria-label="rightRail.pendingChanges: 27"');
  });
});
