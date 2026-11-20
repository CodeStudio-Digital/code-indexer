import { expect, it, vi } from 'vitest';
import { CodeIndexDB } from '@mcp/store/db.js';
import { DocStore } from '@mcp/store/doc-store.js';
import type { DocHybridSearch } from '@mcp/services/services/docs/index.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { buildDocsToolset } from '../tools/index.js';
import type { DocsFinishSlot } from '../tools/docs-finish.js';

it('pins two collections across tools and requires a complete, current passage for high confidence', async () => {
  const db = new CodeIndexDB(':memory:');
  try {
    const docs = new DocStore(db.raw());
    const ids = ['current', 'archive', 'outside'].map(name => {
      const collection = docs.createCollection({ name });
      const source = docs.createSource({ collection_id: collection.id, type: 'url', uri: 'https://example.test/' + name });
      const [chunk] = docs.insertChunks([{ collection_id: collection.id, source_id: source.id, ord: 0,
        content: 'a'.repeat(5999) + '🚀 last', content_hash: 'initial', source_uri: source.uri, anchor: 'method' }]);
      return { collection: collection.id, chunk: chunk! };
    });
    const [current, archive, outside] = ids as [typeof ids[number], typeof ids[number], typeof ids[number]];
    const search = vi.fn().mockResolvedValue({ results: [{ chunk_id: current.chunk, collection: 'current', concepts: [],
      content: 'first page', snippet: 'first page', score: 1 }], diag: { fts_hits: 1, vector_hits: 0, mode: 'fts' } });
    const finishSlot: DocsFinishSlot = { payload: null };
    const tools = buildDocsToolset({ docStore: docs, docHybridSearch: { search } as unknown as DocHybridSearch,
      resolver: {} as never, scopedCollections: ['current', 'archive'], finishSlot, planSlot: { subQuestions: ['method'] },
      counters: { searches: 0, chunks_read: 0, synthesizes: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 } });
    const call = (name: string, args: Record<string, unknown>) =>
      tools.find(t => t.name === name)!.handler(args, {} as ToolContext);
    expect((await call('docs_list_sources', {})).content).not.toContain('outside');
    expect((await call('docs_search', { query: 'method', collection: 'outside' })).isError).toBe(true);
    await call('docs_search', { query: 'method' });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ collection_ids: [current.collection, archive.collection] }));
    expect((await call('docs_read_chunk', { chunk_id: outside.chunk })).isError).toBe(true);
    const finish = (id: number, confidence = 'high') => call('docs_finish', { markdown: 'Method [^1]', chunks_cited: [id], confidence });
    expect((await finish(outside.chunk, 'medium')).isError).toBe(true);
    const page = await call('docs_read_chunk', { chunk_id: current.chunk });
    expect(page.content).toContain('next_char_offset=5999');
    expect((await finish(current.chunk)).isError).toBe(true);
    const next = await call('docs_read_chunk', { chunk_id: current.chunk, char_offset: 5999 });
    expect(next.content).toContain('🚀 last');
    db.raw().prepare('UPDATE doc_chunks SET content_hash=? WHERE id=?').run('changed', current.chunk);
    expect((await finish(current.chunk)).isError).toBe(true);
    db.raw().prepare('UPDATE doc_chunks SET content_hash=? WHERE id=?').run('initial', current.chunk);
    expect((await finish(current.chunk)).isError).toBeFalsy();
  } finally { db.close(); }
});
