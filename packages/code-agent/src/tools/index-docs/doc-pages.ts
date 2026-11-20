import type { DocChunkRead, DocSectionRead, DocOutline } from '@mcp/code-agent/tools/doc-search-types.js';
import type { McpSourceTruncation, McpToolOutput } from './doc-tool.js';

export function docInteger(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error(`${key} must be an integer >= ${min}`);
  return Math.min(value, max);
}
export const docPageSchema = {
  offset: { type: 'integer', minimum: 0, description: 'Page offset from next_offset. Restart at zero if the index changed.' },
  limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Rows per page; sections cap at 64, outlines at 500.' },
};
const points = (s: string) => Array.from(s).length;
const output = (value: unknown, omissions: McpSourceTruncation[], recovery: Record<string, unknown>[]): McpToolOutput => ({
  text: JSON.stringify({ ...(value as object), ...(recovery.length ? { recovery } : {}) }, null, 2),
  ...(omissions.length ? { sourceTruncations: omissions } : {}),
});
function bodyOmission(length: number | undefined, retained: number, technique: string): McpSourceTruncation[] {
  return length != null && length > retained ? [{ technique, inputSize: length, outputSize: retained, unit: 'chars', recoverable: true }] : [];
}
export function chunkOutput(read: DocChunkRead): McpToolOutput {
  const c = read.chunk, omissions = bodyOmission(c.content_length, points(c.content), 'docs-chunk-page');
  const recovery: Record<string, unknown>[] = [];
  if (c.next_char_offset != null) recovery.push({ tool: 'rag_read_doc', chunk_id: c.chunk_id, char_offset: c.next_char_offset, window: 0 });
  if (c.char_offset) recovery.push({ tool: 'rag_read_doc', chunk_id: c.chunk_id, char_offset: 0, window: 0 });
  for (const neighbor of [...read.prev, ...read.next]) {
    const omitted = bodyOmission(neighbor.content_length, points(neighbor.content), 'docs-neighbor-preview');
    omissions.push(...omitted);
    if (omitted.length) recovery.push({ tool: 'rag_read_doc', chunk_id: neighbor.chunk_id, window: 0 });
  }
  return output(read, omissions, recovery);
}
export function sectionOutput(read: DocSectionRead, chunkId: number, limit: number): McpToolOutput {
  const omissions: McpSourceTruncation[] = [], recovery: Record<string, unknown>[] = [];
  if (read.next_offset != null || read.offset) {
    omissions.push({ technique: 'docs-section-page', inputSize: (read.offset ?? 0) + read.chunks.length + (read.next_offset != null ? 1 : 0),
      inputSizeExact: read.next_offset == null, outputSize: read.chunks.length, unit: 'items', recoverable: true });
    recovery.push({ tool: 'rag_read_doc', chunk_id: chunkId, mode: 'section', offset: read.next_offset ?? 0, limit });
  }
  for (const c of read.chunks) {
    omissions.push(...bodyOmission(c.content_length, points(c.content), 'docs-section-chunk-page'));
    if (c.next_char_offset != null) recovery.push({ tool: 'rag_read_doc', chunk_id: c.chunk_id, char_offset: c.next_char_offset, window: 0 });
  }
  return output(read, omissions, recovery);
}
export function outlineOutput(read: DocOutline, input: Record<string, unknown>): McpToolOutput {
  const omissions: McpSourceTruncation[] = [], recovery: Record<string, unknown>[] = [];
  if (read.next_offset != null || read.offset) {
    // Heading groups can merge multiple rows on a page; do not claim an exact
    // total of headings from the underlying chunk offset.
    const retained = read.sources?.length ?? read.headings?.length ?? 0;
    omissions.push({ technique: 'docs-outline-page', inputSize: retained + 1, inputSizeExact: false,
      outputSize: retained, unit: 'items', recoverable: true });
    recovery.push({ tool: 'rag_doc_outline', ...input, offset: read.next_offset ?? 0 });
  }
  return output(read, omissions, recovery);
}
