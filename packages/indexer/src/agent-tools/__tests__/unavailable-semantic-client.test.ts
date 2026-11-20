/**
 * A process with no semantic owner (no client handed to the port): search
 * and search_memory fall back to FTS with the default "unavailable" text.
 */
import { describe, expect, it } from 'vitest';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import { createIndexToolContext } from '../context.js';
import { UNAVAILABLE_SEMANTIC_SEARCH_CLIENT } from '../semantic-client.js';

describe('index tools without a semantic owner', () => {
  it('fail every semantic read with the default text, without a request', async () => {
    await expect(UNAVAILABLE_SEMANTIC_SEARCH_CLIENT.searchProject(7, 'query', { mode: 'hybrid' }))
      .resolves.toEqual({ ok: false, value: null, error: 'semantic server unavailable' });
    await expect(UNAVAILABLE_SEMANTIC_SEARCH_CLIENT.searchProjectMemory(7, 'query', 5))
      .resolves.toEqual({ ok: false, value: null, error: 'semantic server unavailable' });
  });

  it('is the client of a context built without one', () => {
    const db = { raw: () => ({}), getProject: () => undefined } as unknown as CodeIndexDB;
    const ctx = createIndexToolContext({} as IndexerConfig, db);
    expect(ctx.semanticSearchClient).toBe(UNAVAILABLE_SEMANTIC_SEARCH_CLIENT);
  });
});
