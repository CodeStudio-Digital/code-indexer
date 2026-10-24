import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { err } from '@mcp/code-agent/core/tool.js';
import type { DocSearchBackend, DocChunkRead, DocSectionRead } from '@mcp/code-agent/tools/doc-search-types.js';

export const NATIVE_RESEARCH_TOOLS = new Set(['rag_search_docs', 'rag_read_doc', 'rag_doc_outline']);
const MAX_EVIDENCE_BYTES = 192 * 1024;
const MAX_CHUNKS = 32;

export interface NativeResearchEvidence {
  chunk_id: number;
  collection: string;
  source_uri: string | null;
  heading_path: string | null;
  content: string;
  partial: boolean;
  char_offset?: number;
  additional_pages?: Array<{ char_offset: number; content: string }>;
}

/** The corpus is per invocation. A child can only open ids actually discovered
 * in this research, and a backend scope mismatch is never shown to the model. */
export class NativeDocsResearchCorpus {
  readonly evidence = new Map<number, NativeResearchEvidence>();
  searches = 0;
  chunksRead = 0;
  private readonly chunks = new Set<number>();
  private readonly sources = new Set<number>();
  private evidenceBytes = 0;
  private readonly collections: Set<string>;

  constructor(private readonly backend: DocSearchBackend, collections: readonly string[] = []) {
    if (collections.length > 16 || collections.some(c => !c.trim() || c.length > 256)) throw new Error('Research accepts at most 16 bounded collection names');
    this.collections = new Set(collections.map(c => c.trim()));
  }

  decorate = (tool: CoderTool): CoderTool => {
    if (!NATIVE_RESEARCH_TOOLS.has(tool.name) || tool.source !== 'native' || tool.mutates !== false
      || tool.parallelSafe !== true || tool.riskLevel !== 'read' || tool.effectBoundary !== undefined) {
      throw new Error('Native research requires the sealed documentation read capability');
    }
    return { ...tool, handler: async (args, context) => {
      try {
        context.signal?.throwIfAborted();
        const value = tool.name === 'rag_search_docs' ? await this.search(args, context)
          : tool.name === 'rag_read_doc' ? await this.read(args, context) : await this.outline(args, context);
        context.signal?.throwIfAborted();
        const content = JSON.stringify(value);
        if (Buffer.byteLength(content) > 256 * 1024) return err('Documentation page exceeds the research result budget; request a smaller page');
        return { content };
      } catch (cause) {
        context.signal?.throwIfAborted();
        return err(cause instanceof Error ? cause.message : 'Native documentation read failed');
      }
    } };
  };

  private checkCollection(value: string): void {
    if (this.collections.size && !this.collections.has(value)) throw new Error('Documentation result is outside the requested research collections');
  }
  private collection(value: unknown): string | undefined {
    const chosen = typeof value === 'string' ? value.trim() : '';
    if (chosen) { this.checkCollection(chosen); return chosen; }
    if (this.collections.size === 1) return [...this.collections][0];
    if (this.collections.size > 1) throw new Error('Choose one requested collection for each search or outline call');
    return undefined;
  }
  private async search(args: Record<string, unknown>, context: ToolContext) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query || query.length > 4096) throw new Error('Research query must contain 1 to 4096 characters');
    const collection = this.collection(args.collection);
    const response = await this.backend.search({ query, collection, limit: bounded(args.limit, 5, 10),
      scope: 'project', project_id: context.projectId }, context.signal);
    context.signal?.throwIfAborted(); this.searches++;
    if (response.results.length > 10) throw new Error('Documentation backend exceeded the requested search bound');
    for (const result of response.results) this.checkCollection(result.collection);
    if (!response.diag.no_good_match) for (const result of response.results) {
      this.chunks.add(result.chunk_id); this.sources.add(result.source_id);
    }
    return response.diag.no_good_match ? { results: [], diag: response.diag,
      note: 'No sufficiently relevant documentation. Refine the question or report the evidence gap.' } : response;
  }
  private async read(args: Record<string, unknown>, context: ToolContext) {
    const id = positiveId(args.chunk_id);
    if (!this.chunks.has(id)) throw new Error('Read a chunk id returned by this research search or outline first');
    if (args.mode === 'section') {
      if (!this.backend.readSection) throw new Error('Section reads are unavailable; use chunk mode');
      const page = await this.backend.readSection({ chunk_id: id, offset: bounded(args.offset, 0, 100_000, true),
        limit: bounded(args.limit, 4, 4) }, context.signal);
      context.signal?.throwIfAborted();
      if (!page) throw new Error('Documentation changed; search again for current chunk ids');
      this.checkCollection(page.collection);
      if (page.chunks.length > 4) throw new Error('Documentation backend exceeded the requested section bound');
      this.recordSection(page); return page;
    }
    if (!this.backend.readChunk) throw new Error('Documentation chunk reads are unavailable');
    const offset = bounded(args.char_offset, 0, 1_000_000, true);
    const page = await this.backend.readChunk({ chunk_id: id, window: 0,
      char_offset: offset, max_chars: bounded(args.max_chars, 16_384, 32_768) }, context.signal);
    context.signal?.throwIfAborted();
    if (!page) throw new Error('Documentation changed; search again for current chunk ids');
    this.checkCollection(page.chunk.collection);
    if (page.chunk.chunk_id !== id) throw new Error('Documentation backend returned a different chunk');
    if (page.chunk.char_offset != null && page.chunk.char_offset !== offset) throw new Error('Documentation backend returned a different content page');
    this.recordChunk(page.chunk, offset);
    // Neighbors have no collection identity; do not accidentally widen scope.
    return { chunk: page.chunk, prev: [], next: [] };
  }
  private async outline(args: Record<string, unknown>, context: ToolContext) {
    if (!this.backend.outline) throw new Error('Documentation outlines are unavailable');
    const source = args.source_id == null ? undefined : positiveId(args.source_id);
    if (source && !this.sources.has(source)) throw new Error('Open a source returned by this research search or collection outline first');
    const collection = source ? undefined : this.collection(args.collection);
    if (!source && !collection) throw new Error('A collection is required for its source outline');
    const outline = await this.backend.outline({ source_id: source, collection,
      offset: bounded(args.offset, 0, 100_000, true), limit: bounded(args.limit, 32, 64) }, context.signal);
    context.signal?.throwIfAborted();
    if (!outline) throw new Error('Documentation outline is unavailable');
    this.checkCollection(outline.collection);
    if ((outline.sources?.length ?? 0) > 64 || (outline.headings?.length ?? 0) > 64) throw new Error('Documentation backend exceeded the requested outline bound');
    for (const row of outline.sources ?? []) this.sources.add(row.source_id);
    for (const row of outline.headings ?? []) this.chunks.add(row.chunk_id);
    return outline;
  }
  private recordChunk(chunk: DocChunkRead['chunk'], offset: number): void {
    this.record([{ chunk_id: chunk.chunk_id, collection: chunk.collection, source_uri: chunk.source_uri,
      heading_path: chunk.heading_path, content: chunk.content, char_offset: offset,
      partial: offset > 0 || chunk.next_char_offset != null }]);
  }
  private recordSection(section: DocSectionRead): void {
    this.record(section.chunks.map(chunk => ({ chunk_id: chunk.chunk_id, collection: section.collection,
      source_uri: section.source_uri, heading_path: section.heading_path, content: chunk.content,
      partial: chunk.next_char_offset != null })));
    for (const chunk of section.chunks) this.chunks.add(chunk.chunk_id);
  }
  private record(values: NativeResearchEvidence[]): void {
    const next = new Map(this.evidence);
    for (const value of values) next.set(value.chunk_id, mergeEvidence(next.get(value.chunk_id), value));
    const bytes = Buffer.byteLength(JSON.stringify([...next.values()]));
    if (next.size > MAX_CHUNKS || bytes > MAX_EVIDENCE_BYTES) throw new Error('Research evidence budget is full; synthesize the evidence already read');
    this.evidenceBytes = bytes;
    for (const value of values) this.evidence.set(value.chunk_id, next.get(value.chunk_id)!);
    this.chunksRead += values.length;
  }
  reviewEvidence(): string {
    if (this.evidenceBytes > MAX_EVIDENCE_BYTES) throw new Error('Research evidence exceeds its review budget');
    return JSON.stringify([...this.evidence.values()]);
  }
}

function mergeEvidence(previous: NativeResearchEvidence | undefined, value: NativeResearchEvidence): NativeResearchEvidence {
  if (!previous) return value;
  if (previous.collection !== value.collection || previous.source_uri !== value.source_uri || previous.heading_path !== value.heading_path) {
    throw new Error('Documentation changed during research; start a fresh search');
  }
  const pages = [{ char_offset: previous.char_offset ?? 0, content: previous.content }, ...(previous.additional_pages ?? [])];
  const incoming = { char_offset: value.char_offset ?? 0, content: value.content };
  for (const page of pages) {
    const start = Math.max(page.char_offset, incoming.char_offset);
    const end = Math.min(page.char_offset + page.content.length, incoming.char_offset + incoming.content.length);
    if (end > start && page.content.slice(start - page.char_offset, end - page.char_offset)
      !== incoming.content.slice(start - incoming.char_offset, end - incoming.char_offset)) {
      throw new Error('Documentation content changed between pages; start a fresh search');
    }
  }
  const same = pages.findIndex(page => page.char_offset === incoming.char_offset);
  if (same < 0) pages.push(incoming);
  else if (pages[same]!.content.length < incoming.content.length) pages[same] = incoming;
  if (pages.length > 32) throw new Error('Research evidence page limit reached; synthesize the evidence already read');
  pages.sort((left, right) => left.char_offset - right.char_offset);
  const [first, ...additional] = pages;
  return { ...value, content: first!.content, char_offset: first!.char_offset,
    partial: previous.partial || value.partial,
    ...(additional.length ? { additional_pages: additional } : {}) };
}

function positiveId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('Documentation id must be a positive integer');
  return value;
}
function bounded(value: unknown, fallback: number, maximum: number, zero = false): number {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new Error('Invalid documentation page bound');
  return Math.min(value, maximum);
}
