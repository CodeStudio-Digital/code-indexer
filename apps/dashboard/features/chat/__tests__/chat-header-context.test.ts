import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from 'i18next';
import { beforeAll, expect, it } from 'vitest';
import { TooltipProvider } from '../../../components/ui/tooltip.js';
import { bootstrapTestI18n } from '../../../i18n/test-bootstrap.js';
import { ChatHeader } from '../ChatHeader.js';
import { sessionContextUsage } from '../prompt-cache-metrics.js';
import type { CoderSession } from '../types.js';

const session: CoderSession = {
  id: '018f0f5e-7b2d-7a45-8c11-0123456789ab', project_id: 1, title: 'Nova sessão (cópia)',
  provider: 'zai', model: 'glm-5.3', status: 'running', total_input_tokens: 3_512_000,
  total_output_tokens: 2_374, total_cache_read_tokens: 3_504_050, total_cache_creation_tokens: 0,
  last_turn_input_tokens: 158_309, group_id: null, is_archived: false, archived_at: null,
  is_favorite: false, favorited_at: null, created_at: '', updated_at: '',
};

beforeAll(async () => {
  await bootstrapTestI18n();
  await i18n.changeLanguage('pt-BR');
});

it.each([158_548, 158_868, 158_989, 159_126])('displays the exact live prompt of %i tokens', tokens => {
  const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ChatHeader, {
    session, streaming: true, lastUsage: null, stats: null, indexStatus: null, onOpenDetails() {},
    runDelta: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    contextStatus: { turn: 3, prompt_tokens: tokens, context_window: 991_808, ratio: tokens / 991_808, source: 'usage' },
  })));
  expect(html).toContain(`${tokens.toLocaleString('pt-BR')} / 991.808`);
  expect(html).toContain(`aria-valuenow="${tokens}"`);
});

it('keeps an estimate and its effective window when reloading, and accepts a smaller next prompt', () => {
  const persisted = { prompt_tokens: 159_126, source: 'estimate' as const, context_window: 991_808 };
  const stats = { last_turn_context: persisted, context_window: 1_000_000 };
  expect(sessionContextUsage(session, stats)).toMatchObject({ tokens: 159_126, window: 991_808, estimated: true });
  expect(sessionContextUsage(session, stats, { ...persisted, prompt_tokens: 90_321, source: 'usage' }))
    .toMatchObject({ tokens: 90_321, estimated: false });
});
