import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodeIndexDB } from '@mcp/store/db.js';
import { DocStore } from '@mcp/store/doc-store.js';
import { buildDocNavigation } from '../doc-navigation.js';
import { ragReadDocTool } from '@mcp/code-agent/tools/rag-read-doc.js';
import { ragDocOutlineTool } from '@mcp/code-agent/tools/rag-doc-outline.js';
import { setGlobalDocSearch } from '@mcp/code-agent/tools/rag-search-docs.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

let db: CodeIndexDB, store: DocStore, collection: number, source: number;
beforeEach(() => {
  db = new CodeIndexDB(':memory:'); store = new DocStore(db.raw());
  collection = store.createCollection({ name: 'docs' }).id;
  source = store.createSource({ collection_id: collection, type: 'url', uri: 'https://docs.example/guide' }).id;
});
afterEach(() => { setGlobalDocSearch(null); db.close(); });
const seed = (count: number, body = (n: number) => 'body-' + n, heading = (n: number) => 'Heading ' + n) =>
  store.insertChunks(Array.from({ length: count }, (_, n) => ({ collection_id: collection, source_id: source, ord: n,
    content: body(n), content_hash: 'hash-' + n, heading_path: heading(n), token_count: 5, source_uri: 'https://docs.example/guide' })));

it('paginates 1000 headings without loading document bodies or dropping the tail', async () => {
  const ids = seed(1000); const nav = buildDocNavigation(store);
  const readAll = vi.spyOn(store, 'listChunkOutlineBySource');
  const first = await nav.outline({ source_id: source, limit: 100 });
  expect(first?.headings).toHaveLength(100); expect(first?.next_offset).toBe(100);
  const last = await nav.outline({ source_id: source, offset: 900, limit: 100 });
  expect(last?.headings?.at(-1)?.chunk_id).toBe(ids.at(-1)); expect(last?.next_offset).toBeUndefined();
  expect(readAll).not.toHaveBeenCalled();
});

it('recovers all section pages and complete Unicode chunk text with bounded SQL reads', async () => {
  const text = '🙂'.repeat(70000) + 'END'; const ids = seed(70, n => n === 0 ? text : 'part-' + n, () => 'Large section');
  const nav = buildDocNavigation(store);
  const first = await nav.readSection({ chunk_id: ids[0] });
  expect(first?.chunks).toHaveLength(32); expect(first?.next_offset).toBe(32);
  expect(first?.chunks[0].next_char_offset).toBe(65536);
  const tail = await nav.readSection({ chunk_id: ids[0], offset: 64 });
  expect(tail?.chunks.at(-1)?.content).toBe('part-69'); expect(tail?.next_offset).toBeUndefined();
  const chunk = await nav.readChunk({ chunk_id: ids[0], window: 0 });
  const rest = await nav.readChunk({ chunk_id: ids[0], char_offset: chunk!.chunk.next_char_offset, window: 0 });
  expect(chunk!.chunk.content + rest!.chunk.content).toBe(text);
  expect(chunk!.chunk.content).not.toContain('\uFFFD'); expect(chunk!.chunk.content_length).toBe(70003);
});

it('keeps source pages separate, bounds neighbors, and advertises continuation to the model', async () => {
  const ids = seed(4, () => 'a'.repeat(70000), () => 'Same heading');
  const nav = buildDocNavigation(store);
  setGlobalDocSearch({ search: async () => { throw new Error('unused'); }, ...nav });
  const result = await ragReadDocTool.handler({ chunk_id: ids[1], max_chars: 1000 }, {} as ToolContext);
  expect(result.content).toContain('char_offset:1000'); expect(result.content).toContain('truncated — rag_read_doc');
  expect(result.sourceTruncations).toEqual(expect.arrayContaining([expect.objectContaining({ technique: 'rag-chunk-page', recoverable: true }), expect.objectContaining({ technique: 'rag-neighbor-preview', inputSize: 140000 })]));
  const section = await ragReadDocTool.handler({ chunk_id: ids[0], mode: 'section', limit: 2 }, {} as ToolContext);
  expect(section.content).toContain('offset:2'); expect(section.content).toContain('Chunk continues');
  const lastSection = await ragReadDocTool.handler({ chunk_id: ids[0], mode: 'section', offset: 2, limit: 2 }, {} as ToolContext);
  expect(lastSection.sourceTruncations).toEqual(expect.arrayContaining([expect.objectContaining({ technique: 'rag-section-page', inputSize: 4, inputSizeExact: true })]));
  const outline = await ragDocOutlineTool.handler({ source_id: source, limit: 2 }, {} as ToolContext);
  expect(outline.content).toContain('"offset":2'); expect(outline.sourceTruncations?.[0].recoverable).toBe(true);
});

it('rejects pre-cancelled navigation before querying and restores busy_timeout', async () => {
  const ids = seed(1); const nav = buildDocNavigation(store), reads = vi.spyOn(store, 'agentReads');
  const before = db.raw().pragma('busy_timeout', { simple: true });
  const ctrl = new AbortController(); ctrl.abort(new Error('attempt stopped'));
  await expect(nav.readChunk({ chunk_id: ids[0] }, ctrl.signal)).rejects.toThrow('attempt stopped'); expect(reads).not.toHaveBeenCalled();
  await nav.readChunk({ chunk_id: ids[0] }); expect(db.raw().pragma('busy_timeout', { simple: true })).toBe(before);
});

it('pages collection summaries and refuses invalid tool cursor inputs', async () => {
  for (let n = 0; n < 5; n++) store.createSource({ collection_id: collection, type: 'url', uri: 'https://docs.example/' + n });
  const nav = buildDocNavigation(store); const first = await nav.outline({ collection: 'docs', limit: 2 });
  expect(first?.sources).toHaveLength(2); expect(first?.next_offset).toBe(2);
  const next = await nav.outline({ collection: 'docs', offset: 2, limit: 2 }); expect(next?.sources?.[0].source_id).not.toBe(first?.sources?.[0].source_id);
  setGlobalDocSearch({ search: async () => { throw new Error('unused'); }, ...nav });
  expect((await ragDocOutlineTool.handler({ source_id: 1.5 }, {} as ToolContext)).isError).toBe(true);
  expect((await ragReadDocTool.handler({ chunk_id: 1, char_offset: -1 }, {} as ToolContext)).isError).toBe(true);
});
