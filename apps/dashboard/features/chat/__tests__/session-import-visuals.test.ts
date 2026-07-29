import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTestI18n } from '../../../i18n/test-bootstrap.js';
import { TooltipProvider } from '../../../components/ui/tooltip.js';
import { ChatHeader } from '../ChatHeader.js';
import type { CoderSession } from '../types.js';

function importedSession(source: 'claude-code' | 'codex'): CoderSession {
  return {
    id: '018f0f5e-7b2d-7a45-8c11-0123456789ab',
    project_id: 1, title: 'Imported work', provider: 'openai', model: 'gpt-5',
    status: 'idle', total_input_tokens: 0, total_output_tokens: 0,
    total_cache_read_tokens: 0, total_cache_creation_tokens: 0, last_turn_input_tokens: 0,
    group_id: null, is_archived: false, archived_at: null, is_favorite: false, favorited_at: null,
    import_source: source, import_external_id: 'external-9', import_fingerprint: 'abc',
    import_source_updated_at: null, imported_at: '2026-07-14T12:00:00.000Z',
    created_at: '2026-07-14T12:00:00.000Z', updated_at: '2026-07-14T12:00:00.000Z',
  };
}

describe('imported session visuals', () => {
  beforeAll(bootstrapTestI18n);

  it('shows the Claude Code origin in the active-session header', () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ChatHeader, {
      session: importedSession('claude-code'), streaming: false, runDelta: {}, lastUsage: null,
      stats: null, contextStatus: null, indexStatus: null, onOpenDetails: () => {},
    })));
    expect(html).toContain('Claude Code');
    expect(html).toContain('Imported work');
  });

  it('shows the Codex origin in the active-session header', () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ChatHeader, {
      session: importedSession('codex'), streaming: false, runDelta: {}, lastUsage: null,
      stats: null, contextStatus: null, indexStatus: null, onOpenDetails: () => {},
    })));
    expect(html).toContain('Codex');
  });
});
