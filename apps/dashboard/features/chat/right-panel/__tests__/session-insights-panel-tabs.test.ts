import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => ({
        'insights.overview': 'Overview',
        'insights.usage': 'Usage',
        'insights.tools': 'Tools',
        'insights.inputs': 'Inputs',
        'insights.tabsLabel': 'Session insights',
        'details.noData': 'No data',
      })[key] ?? key,
    }),
  };
});

vi.mock('../../SessionDetailsModal.js', () => ({
  SessionInputsView: () => null,
  SessionSummaryView: () => createElement('div', null, 'Summary'),
}));

vi.mock('../../SessionMetricsModal.js', () => ({
  SessionMetricsView: () => null,
}));

vi.mock('../../ToolStatsModal.js', () => ({
  ToolStatsView: () => null,
}));

import { SessionInsightsPanel } from '../SessionInsightsPanel.js';

describe('SessionInsightsPanel tabs', () => {
  it('keeps only the active label open and reveals inactive labels on hover or focus', () => {
    const html = renderToStaticMarkup(createElement(SessionInsightsPanel, {
      sessionId: 'session-1',
      session: null,
      stats: null,
    }));

    expect(html).toContain('overflow-hidden');
    expect(html).not.toContain('overflow-x-auto');
    expect(html).toMatch(
      /<span class="[^"]*ml-1\.5 max-w-\[120px\] opacity-100[^"]*">Overview<\/span>/,
    );
    expect(html).toMatch(
      /<span class="[^"]*ml-0 max-w-0 opacity-0[^"]*group-hover\/insights-tab:max-w-\[120px\][^"]*">Usage<\/span>/,
    );
    expect(html).toContain('group-focus-visible/insights-tab:max-w-[120px]');
    expect(html).toContain('aria-label="Usage"');
  });
});
