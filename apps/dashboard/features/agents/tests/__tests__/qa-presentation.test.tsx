import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { TestsTab } from '../TestsTab.js';

const diagnostics = vi.hoisted(() => vi.fn(() => ({ data: null, loading: false, error: null, refresh: vi.fn() })));
vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../live/useLiveRun.js', () => ({ useLiveRun: () => ({ run: null, results: [], loading: false, error: null }) }));
vi.mock('../live/useQaDiagnostics.js', () => ({ useQaDiagnostics: diagnostics }));
vi.mock('../shared/useSessionServices.js', () => ({ useSessionServices: () => ({ services: [], loading: false }) }));

it('leads with preview validation and groups regression controls in one collapsed advanced section', () => {
  const html = renderToStaticMarkup(<TestsTab sessionId="session-fixture" />);
  expect(html.match(/<details\b/g)).toHaveLength(1);
  expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
  expect(html.indexOf('Validação no preview')).toBeGreaterThan(-1);
  expect(html.indexOf('Validação no preview')).toBeLessThan(html.indexOf('<details'));
  expect(html).toContain('Regressão Playwright · opções avançadas');
  expect(html).toContain('Restore QA config');
  expect(html).toContain('URLs');
  expect(diagnostics).toHaveBeenCalledWith('session-fixture', false);
});
