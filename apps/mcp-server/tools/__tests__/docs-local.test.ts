import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodeIndexDB } from '@mcp/store/db.js';
import { DocStore } from '@mcp/store/doc-store.js';
import { setGlobalDocSearch, type DocSearchBackend } from '@mcp/code-agent/tools/rag-search-docs.js';
import { docsTools } from '../docs.js';
import type { ToolContext } from '../../context.js';
import { createDocChunksFtsIfReady } from '@mcp/store/db/schema/fts.js';

let db: CodeIndexDB, store: DocStore, ctx: ToolContext, source: number, ids: number[], project: string;
beforeEach(() => {
  db = new CodeIndexDB(':memory:'); store = new DocStore(db.raw()); ctx = { db } as ToolContext;
  const p = db.createProject('docs-project', 'D:/docs-project'); project = p.name;
  const collection = store.createCollection({ name: 'docs' }).id;
  store.linkProjectCollection(p.id, collection);
  source = store.createSource({ collection_id: collection, type: 'url', uri: 'https://docs.example/guide' }).id;
  ids = store.insertChunks(Array.from({ length: 72 }, (_, n) => ({ collection_id: collection, source_id: source, ord: n,
    content: n === 0 ? 'localunique ' + '🙂'.repeat(70000) + 'TAIL' : 'part-' + n,
    content_hash: 'hash-' + n, heading_path: n === 0 ? 'Introduction' : n === 71 ? 'End' : 'Guide', token_count: 5 })));
});
afterEach(() => { vi.restoreAllMocks(); setGlobalDocSearch(null); db.close(); });
const call = (name: string, args: Record<string, unknown>, context = ctx) => docsTools.find(t => t.name === name)!.handler(args, context);
const parse = (result: Awaited<ReturnType<typeof call>>) => JSON.parse(typeof result === 'string' ? result : result.text);

it('searches standalone stdio locally with truthful Unicode previews and bounded body hydration', async () => {
  vi.spyOn(DocStore.prototype, 'getChunksByIds').mockImplementation(() => { throw new Error('whole bodies forbidden'); });
  vi.spyOn(DocStore.prototype, 'listChunkOutlineBySource').mockImplementation(() => { throw new Error('whole outline forbidden'); });
  const search = await call('rag_search_docs', { query: 'localunique', project_name: project });
  const result = parse(search);
  expect(result.diag).toMatchObject({ mode: 'fts', scope: 'project', embedding_available: false, scoped_collections: ['docs'] });
  expect(result.results[0]).toMatchObject({ chunk_id: ids[0], snippet_source_chars: 70016, snippet_truncated: true });
  expect(result.results[0].snippet_retained_chars).toBe(246);
  expect(result.results[0].snippet).not.toContain('\uFFFD');
  expect(search).toMatchObject({ sourceTruncations: [expect.objectContaining({ inputSize: 70016, outputSize: 246, recoverable: true })] });
  const first = parse(await call('rag_read_doc', { chunk_id: ids[0], window: 0 }));
  const tail = parse(await call('rag_read_doc', { chunk_id: ids[0], char_offset: first.chunk.next_char_offset, window: 0 }));
  expect(first.chunk.content + tail.chunk.content).toBe('localunique ' + '🙂'.repeat(70000) + 'TAIL');
});

it('keeps project-linked search isolated and allows explicit global/collection searches', async () => {
  const other = store.createCollection({ name: 'Other' }).id;
  const s = store.createSource({ collection_id: other, type: 'url', uri: 'https://docs.example/other' }).id;
  store.insertChunks([{ collection_id: other, source_id: s, ord: 0, content: 'otherunique', content_hash: 'other' }]);
  expect(parse(await call('rag_search_docs', { query: 'otherunique', project_name: project })).results).toHaveLength(0);
  expect(parse(await call('rag_search_docs', { query: 'otherunique', project_name: project, scope: 'all' })).results).toHaveLength(1);
  expect(parse(await call('rag_search_docs', { query: 'otherunique', project_name: project, collection: 'Other' })).results).toHaveLength(1);
  await expect(call('rag_search_docs', { query: 'otherunique', project_name: 'missing' })).rejects.toThrow('not found');
});

it('recovers sections, headings and neighbor previews, with exact tail omission counts', async () => {
  const first = parse(await call('rag_read_doc', { chunk_id: ids[1], mode: 'section', limit: 2 }));
  expect(first.next_offset).toBe(2); expect(first.recovery[0]).toMatchObject({ offset: 2, mode: 'section' });
  const tail = await call('rag_read_doc', { chunk_id: ids[1], mode: 'section', offset: 68, limit: 2 });
  expect(parse(tail).chunks.at(-1).content).toBe('part-70');
  expect(tail).toMatchObject({ sourceTruncations: [expect.objectContaining({ inputSize: 70, inputSizeExact: true, outputSize: 2 })] });
  const neighbor = await call('rag_read_doc', { chunk_id: ids[1] });
  expect(neighbor).toMatchObject({ sourceTruncations: [expect.objectContaining({ technique: 'docs-neighbor-preview', inputSize: 70016, outputSize: 1201 })] });
  expect(parse(neighbor).recovery[0]).toMatchObject({ chunk_id: ids[0], window: 0 });
  const headings = parse(await call('rag_doc_outline', { source_id: source, limit: 2 }));
  expect(headings.next_offset).toBe(2);
  const end = parse(await call('rag_doc_outline', { source_id: source, offset: 70, limit: 2 }));
  expect(end.headings.at(-1).heading_path).toBe('End'); expect(end.next_offset).toBeUndefined();
  expect(end.recovery[0].offset).toBe(0);
});

it('paginates sources and makes missing/invalid inputs real transport errors', async () => {
  for (let n = 0; n < 4; n++) store.createSource({ collection_id: store.getCollectionByName('docs')!.id, type: 'url', uri: 'https://docs.example/' + n });
  const first = parse(await call('rag_doc_outline', { collection: 'docs', limit: 2 }));
  const tail = parse(await call('rag_doc_outline', { collection: 'docs', offset: 4, limit: 2 }));
  expect(first.sources).toHaveLength(2); expect(tail.sources).toHaveLength(1);
  for (const [name, args] of [
    ['rag_read_doc', { chunk_id: 1.5 }], ['rag_read_doc', { chunk_id: ids[0], char_offset: -1 }],
    ['rag_read_doc', { chunk_id: ids[0], mode: 'invalid' }], ['rag_read_doc', { chunk_id: 99999 }],
    ['rag_doc_outline', { source_id: source, limit: Infinity }], ['rag_doc_outline', { collection: 'missing' }],
    ['rag_search_docs', { query: 'x', limit: NaN }], ['rag_search_docs', { query: 'x'.repeat(4097) }],
  ] as const) await expect(call(name, args)).rejects.toThrow();
});

it('rebuilds a missing derived FTS index from existing rows without requiring another reopen', async () => {
  db.raw().exec('DROP TABLE doc_chunks_fts');
  createDocChunksFtsIfReady(db.raw());
  expect(parse(await call('rag_search_docs', { query: 'localunique' })).results[0].chunk_id).toBe(ids[0]);
  const exec = vi.spyOn(db.raw(), 'exec');
  createDocChunksFtsIfReady(db.raw());
  expect(exec.mock.calls.some(([sql]) => sql.includes("VALUES('rebuild')"))).toBe(false);
});

it('forwards cancellation to HTTP and never publishes a stale reply', async () => {
  const ctrl = new AbortController(); ctx.signal = ctrl.signal;
  const search = vi.fn(async (_input, signal) => { expect(signal).toBe(ctrl.signal); ctrl.abort(new Error('attempt replaced')); return { results: [], diag: {} }; });
  setGlobalDocSearch({ search } as unknown as DocSearchBackend);
  await expect(call('rag_search_docs', { query: 'x' })).rejects.toThrow('attempt replaced');
  search.mockClear(); await expect(call('rag_search_docs', { query: 'x' })).rejects.toThrow('attempt replaced');
  expect(search).not.toHaveBeenCalled();
});
