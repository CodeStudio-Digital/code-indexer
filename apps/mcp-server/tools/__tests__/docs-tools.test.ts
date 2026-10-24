import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setGlobalDocSearch,
  type DocSearchBackend,
} from '@mcp/code-agent/tools/rag-search-docs.js';
import type { ToolContext } from '../../context.js';
import { docsTools } from '../docs.js';

const ctx = {} as ToolContext;

function textOf(result: Awaited<ReturnType<(typeof docsTools)[number]['handler']>>): string {
  return typeof result === 'string' ? result : result.text;
}

function baseBackend(overrides: Partial<DocSearchBackend> = {}): DocSearchBackend {
  return {
    search: async () => ({
      results: [],
      diag: {
        fts_hits: 0,
        vector_hits: 0,
        mode: 'fts',
        embedding_available: false,
        vector_available: false,
      },
    }),
    ...overrides,
  };
}

afterEach(() => {
  setGlobalDocSearch(null);
});

describe('MCP documentation tools', () => {
  it('transports exact snippet and result-limit omissions with complete search JSON', async () => {
    setGlobalDocSearch(baseBackend({
      search: vi.fn(async () => ({
        results: [{
          chunk_id: 41,
          collection: 'Unity',
          source_id: 9,
          source_uri: 'https://example.test/api',
          heading_path: 'Player > Move',
          anchor: 'move',
          api_symbol: 'Player.Move',
          api_signature: 'void Move(Vector3 direction)',
          snippet: 'preview',
          snippet_source_chars: 900,
          snippet_retained_chars: 480,
          snippet_truncated: true,
          score: 0.7,
          relevance: 0.96,
          summary: 'Moves a player.',
          concepts: ['movement'],
        }],
        diag: {
          fts_hits: 5,
          vector_hits: 3,
          mode: 'hybrid' as const,
          embedding_available: true,
          vector_available: true,
          results_before_limit: 5,
          results_truncated: true,
        },
      })) as DocSearchBackend['search'],
    }));
    const tool = docsTools.find((candidate) => candidate.name === 'rag_search_docs')!;

    const result = await tool.handler({ query: 'move', limit: 1 }, ctx);

    expect(typeof result).toBe('object');
    if (typeof result === 'string') throw new Error('Expected structured MCP result');
    expect(result.sourceTruncations).toEqual([
      {
        technique: 'docs-search-snippet-preview',
        inputSize: 900,
        outputSize: 480,
        unit: 'chars',
        recoverable: true,
      },
      {
        technique: 'docs-search-result-limit',
        inputSize: 5,
        outputSize: 1,
        unit: 'items',
        recoverable: true,
      },
    ]);
    expect(JSON.parse(result.text).results[0]).toMatchObject({
      anchor: 'move',
      api_symbol: 'Player.Move',
      api_signature: 'void Move(Vector3 direction)',
      relevance: 0.96,
    });
  });

  it('returns complete chunk neighbors and whole sections without local caps', async () => {
    const neighborContent = 'n'.repeat(18_000);
    const sectionChunks = Array.from({ length: 14 }, (_, index) => ({
      chunk_id: 100 + index,
      ord: index,
      content: `section-${index}-${'s'.repeat(2_000)}`,
      token_count: 500,
    }));
    const readChunk = vi.fn(async () => ({
      chunk: {
        chunk_id: 100,
        collection: 'Unity',
        source_id: 9,
        source_uri: 'https://example.test/api',
        heading_path: 'Player',
        anchor: null,
        api_symbol: null,
        api_signature: null,
        content: 'c'.repeat(20_000),
        token_count: 5_000,
        summary: null,
        concepts: [],
      },
      prev: [],
      next: [{
        chunk_id: 101,
        ord: 1,
        heading_path: 'Player > Move',
        content: neighborContent,
        token_count: 4_500,
        source_uri: 'https://example.test/api',
      }],
    }));
    const readSection = vi.fn(async () => ({
      source_id: 9,
      collection: 'Unity',
      source_uri: 'https://example.test/api',
      heading_path: 'Player',
      anchor: null,
      api_symbol: null,
      api_signature: null,
      doc_type: 'api_reference',
      chunks: sectionChunks,
      total_tokens: 7_000,
    }));
    setGlobalDocSearch(baseBackend({ readChunk, readSection }));
    const tool = docsTools.find((candidate) => candidate.name === 'rag_read_doc')!;

    const chunkResult = await tool.handler({ chunk_id: 100, window: 1 }, ctx);
    const sectionResult = await tool.handler({ chunk_id: 100, mode: 'section' }, ctx);

    const chunk = JSON.parse(textOf(chunkResult));
    const section = JSON.parse(textOf(sectionResult));
    expect(chunk.chunk.content).toHaveLength(20_000);
    expect(chunk.next[0].content).toBe(neighborContent);
    expect(section.chunks).toHaveLength(14);
    expect(section.chunks.at(-1).content).toContain('section-13-');
    expect(readChunk).toHaveBeenCalledWith({ chunk_id: 100, window: 1, char_offset: 0, max_chars: 65536 }, undefined);
    expect(readSection).toHaveBeenCalledWith({ chunk_id: 100, offset: 0, limit: 32 }, undefined);
  });

  it('passes result limits above the old fixed 30 through to the backend', async () => {
    const search = vi.fn(async () => ({
      results: [],
      diag: {
        fts_hits: 0,
        vector_hits: 0,
        mode: 'fts' as const,
        embedding_available: false,
        vector_available: false,
      },
    }));
    setGlobalDocSearch(baseBackend({ search }));
    const tool = docsTools.find((candidate) => candidate.name === 'rag_search_docs')!;

    await tool.handler({ query: 'q', limit: 35 }, ctx);

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: 35 }), undefined);
  });

  it('exposes the complete outline under native read-only tool names', async () => {
    const headings = Array.from({ length: 305 }, (_, index) => ({
      heading_path: `Chapter ${index}`,
      chunk_id: index + 1,
      ord: index,
      sections: 1,
      tokens: 10,
      source_uri: 'https://example.test/book',
    }));
    setGlobalDocSearch(baseBackend({
      outline: async () => ({
        kind: 'headings',
        collection: 'Book',
        source_id: 7,
        title: 'A Book',
        source_uri: 'https://example.test/book',
        doc_type: 'guide',
        headings,
      }),
    }));

    expect(docsTools.map((tool) => [tool.name, tool.scope])).toEqual([
      ['rag_search_docs', 'mcp:read'],
      ['rag_read_doc', 'mcp:read'],
      ['rag_doc_outline', 'mcp:read'],
    ]);
    const tool = docsTools.find((candidate) => candidate.name === 'rag_doc_outline')!;
    const result = await tool.handler({ source_id: 7 }, ctx);
    const outline = JSON.parse(textOf(result));
    expect(outline.headings).toHaveLength(305);
    expect(outline.headings.at(-1)).toMatchObject({ chunk_id: 305, heading_path: 'Chapter 304' });
  });
});
