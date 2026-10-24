/**
 * rag_doc_outline — navigate the indexed doc corpus structurally, filling the
 * gap between rag_search_docs (find by query) and rag_read_doc (read one
 * section):
 *
 *   - rag_doc_outline({collection}) → the SOURCES in that collection.
 *   - rag_doc_outline({source_id})  → that source's HEADING tree, each heading
 *     carrying the first chunk_id (ready to pass to rag_read_doc).
 *
 * Lets an agent browse a doc top-down (collection → source → section) instead
 * of guessing queries. Read-only + parallel-safe → bootstrap tier, like
 * rag_search_docs / rag_read_doc. Backed by the `outline` verb on the same
 * setGlobalDocSearch singleton.
 */
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { getGlobalDocSearch, type DocOutline } from './rag-search-docs.js';
import { docPageArgs } from './doc-page.js';

export const ragDocOutlineTool: CoderTool = {
  name: 'rag_doc_outline',
  description:
    'Browse indexed documentation structurally instead of by query.\n' +
    'Call with {collection: "name"} to LIST the sources in a collection (each printed with a source_id).\n' +
    "Call with {source_id: N} to get that source's HEADING TREE — every section with its chunk_id, ready for rag_read_doc.\n" +
    "USE: to navigate a doc top-down (collection → source → section) when rag_search_docs queries aren't landing, or to see what a doc actually covers before searching.\n" +
    'Collection names come from the <indexed-docs> block or rag_search_docs results; source_ids come from this tool.',
  source: 'native',
  outputPolicy: { mode: 'structured', reducer: 'smart', recovery: 'output_store' },
  parameters: {
    type: 'object',
    properties: {
      offset: { type: 'number', description: 'Next page offset returned by this tool (default 0).' },
      limit: { type: 'number', description: 'Maximum source/chunk rows in this page (default 100, max 500). Headings are grouped within the page.' },
      collection: {
        type: 'string',
        description: 'Collection name — returns its source list. Omit when passing source_id.',
      },
      source_id: {
        type: 'number',
        description: 'Source id (from a prior rag_doc_outline) — returns its heading tree.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const page = docPageArgs(args, 100, 500); if ('error' in page) return page.error;
    const backend = getGlobalDocSearch();
    if (!backend) {
      return err('rag_doc_outline is not configured: the doc corpus backend is not wired into this process.');
    }
    if (!backend.outline) {
      return err('rag_doc_outline is not available in this process. Use rag_search_docs instead.');
    }
    const sourceId = Number(args.source_id);
    const hasSource = Number.isSafeInteger(sourceId) && sourceId > 0;
    if (args.source_id != null && !hasSource) return err('source_id must be a positive integer');
    const collection = typeof args.collection === 'string' ? args.collection.trim() : '';
    if (!hasSource && !collection) {
      return err('Pass a collection name (to list its sources) or a source_id (to see its heading tree).');
    }

    let outline: DocOutline | null;
    try {
      ctx.signal?.throwIfAborted();
      outline = await backend.outline({ ...(hasSource ? { source_id: sourceId } : { collection }), ...page }, ctx.signal);
      ctx.signal?.throwIfAborted();
    } catch (e) {
      return err(`doc outline failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!outline) {
      return err(
        hasSource
          ? `No source with id ${sourceId} — list sources first with rag_doc_outline({collection}).`
          : `No collection named "${collection}". Check the <indexed-docs> block for exact names.`,
      );
    }

    const body = outline.kind === 'sources' ? renderSources(outline) : renderHeadings(outline);
    const next = outline.next_offset == null ? '' : `\n\nMore rows: rag_doc_outline(${JSON.stringify({ ...(hasSource ? { source_id: sourceId } : { collection }), offset: outline.next_offset, limit: page.limit })}). Counts refer to this page.`;
    return { content: body + next, ...(outline.next_offset != null ? { sourceTruncations: [{
      technique: 'rag-outline-page', inputSize: outline.next_offset + 1, inputSizeExact: false,
      outputSize: page.limit, unit: 'items' as const, recoverable: true }] } : {}) };
  },
};

function renderSources(o: DocOutline): string {
  const sources = o.sources ?? [];
  if (sources.length === 0) return `Collection "${o.collection}" has no sources yet.`;
  const lines = sources.map((s) => {
    const kind = s.doc_type && s.doc_type !== 'mixed' ? `${s.type}/${s.doc_type}` : s.type;
    return `- source_id ${s.source_id} · ${kind} · ${s.chunk_count} sections — ${s.title ?? s.uri}`;
  });
  return [
    `# ${o.collection} — ${sources.length} source(s)`,
    ...lines,
    '',
    'Call rag_doc_outline({source_id}) on any of these to see its heading tree.',
  ].join('\n');
}

function renderHeadings(o: DocOutline): string {
  const headings = o.headings ?? [];
  const typeTag = o.doc_type && o.doc_type !== 'mixed' ? ` (${o.doc_type})` : '';
  const head = `# ${o.title ?? o.source_uri ?? 'source'} — ${o.collection}${typeTag}`;
  if (headings.length === 0) {
    return `${head}\n(no headings indexed — the source may still be indexing.)`;
  }
  // Group under page URLs only when the source spans multiple pages (a crawl);
  // a single PDF/page stays a flat list.
  const multiPage = new Set(headings.map((h) => h.source_uri ?? '')).size > 1;
  const lines: string[] = [];
  let lastUri: string | null | undefined;
  for (const h of headings) {
    if (multiPage && h.source_uri !== lastUri) {
      lines.push(`\n## ${h.source_uri ?? '(page)'}`);
      lastUri = h.source_uri;
    }
    const parts = h.sections > 1 ? ` · ${h.sections} parts` : '';
    lines.push(`- ${h.heading_path ?? '(untitled)'} — chunk_id ${h.chunk_id}${parts} (~${h.tokens} tokens)`);
  }
  return [
    head,
    ...lines,
    '',
    'Read any heading in full with rag_read_doc({chunk_id}) — add mode:"section" when it shows multiple parts.',
  ].join('\n');
}

export const ragDocOutlineTools: CoderTool[] = [ragDocOutlineTool];
