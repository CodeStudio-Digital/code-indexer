import { describe, expect, it, vi } from 'vitest';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import { createMcpSemanticSearchClient } from '../semantic-search-client.js';

const config = {
  dashboard: { host: '0.0.0.0', port: 7333 },
} as IndexerConfig;

describe('MCP semantic localhost client', () => {
  it('delegates code and memory reads to loopback endpoints', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes('/agent-memory/search')) {
        return new Response(JSON.stringify({ results: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        results: [], diagnostics: { vectorAvailable: true, embeddingAvailable: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = createMcpSemanticSearchClient(config, fetchImpl as typeof fetch);

    await expect(client.searchProject(7, 'related behavior', {
      mode: 'hybrid', type: 'symbols', limit: 9,
    })).resolves.toMatchObject({ ok: true });
    await expect(client.searchProjectMemory(7, 'build recipe', 4))
      .resolves.toMatchObject({ ok: true });

    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:7333/api/projects/7/search?q=related+behavior&mode=hybrid&type=symbols&limit=9',
    );
    expect(String(fetchImpl.mock.calls[1]![0])).toBe(
      'http://127.0.0.1:7333/api/projects/7/agent-memory/search?q=build+recipe&limit=4',
    );
  });

  it('rejects malformed success payloads instead of hiding an ownership bug', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const client = createMcpSemanticSearchClient(config, fetchImpl as typeof fetch);
    await expect(client.searchProject(1, 'query')).resolves.toMatchObject({
      ok: false,
      error: 'semantic server returned an invalid search payload',
    });
  });
});

