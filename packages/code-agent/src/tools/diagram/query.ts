/**
 * Bounded diagram reads and directory pagination. Export is implemented in
 * export.ts through the owned renderer port and fenced exclusive file creation.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { structuredResult } from '@mcp/code-agent/core/model-output.js';
import {
  fsPort,
  resolveDiagramPath,
  diagramsDirAbs,
  DIAGRAMS_DIR,
} from './shared.js';

export const diagramReadTool: CoderTool = {
  name: 'diagram_read',
  description:
    'Read the complete mxGraph XML of a saved draw.io diagram (up to 4 MiB) so you can edit it with diagram_update. Output beyond the model context limit is preserved by the runner and can be paged with get_tool_output. Larger files can be inspected with read_file.',
  source: 'native',
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Diagram name (diagrams/<slug>.drawio).' } },
    required: ['name'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    ctx.signal?.throwIfAborted();
    const r = resolveDiagramPath(ctx, String(args.name ?? ''));
    if ('error' in r) return r.error;
    const port = fsPort(ctx);
    let xml: string;
    try {
      if (!port.readFileBounded) return err('Filesystem adapter does not support bounded diagram reads.');
      xml = await port.readFileBounded(r.abs, 4 * 1024 * 1024, ctx.signal);
    } catch (error) {
      ctx.signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return err(`No diagram named "${r.slug}" (${r.rel}). Use diagram_list to see existing diagrams.`);
      return err(`Cannot read ${r.rel}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The central finalizer owns context shaping and exact spill recovery.
    // Cutting here permanently discarded the XML tail before it could be
    // stored, and duplicated the runner's model-aware cap.
    return ok(xml);
  },
};

export const diagramListTool: CoderTool = {
  name: 'diagram_list',
  description: 'List saved draw.io diagrams under diagrams/ in filesystem order, 100 per page (maximum 500). Use next_offset for the next page. This is a live listing; restart at offset 0 after directory changes.',
  source: 'native',
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  parameters: { type: 'object', properties: {
    offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 },
    format: { type: 'string', enum: ['text', 'json'] },
  }, additionalProperties: false },
  handler: async (args, ctx) => {
    ctx.signal?.throwIfAborted();
    const offset = args.offset ?? 0, limit = args.limit ?? 100;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 500) return err('offset must be a nonnegative integer and limit must be an integer from 1 to 500.');
    const dir = diagramsDirAbs(ctx);
    if (!dir) return err('Could not resolve the diagrams directory.');
    const port = fsPort(ctx);
    const names: string[] = [];
    let seen = 0, more = false;
    try {
      // Custom legacy ports retain compatibility; the local/native adapter
      // streams entries and closes the directory when this page ends.
      const entries = port.iterateDirectory?.(dir, ctx.signal) ?? await port.readdir(dir, { withFileTypes: true });
      for await (const entry of entries) {
        ctx.signal?.throwIfAborted();
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.drawio')) continue;
        if (seen++ < Number(offset)) continue;
        if (names.length === limit) { more = true; break; }
        names.push(entry.name.replace(/\.drawio$/i, ''));
      }
    } catch (error) {
      ctx.signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return err(`Cannot list diagrams: ${error instanceof Error ? error.message : String(error)}`);
    }
    const next = more ? Number(offset) + names.length : null;
    if (args.format === 'json') return structuredResult(
      { directory: DIAGRAMS_DIR, names, offset, next_offset: next, live_listing: true },
      '', { env: { MCP_TOOL_RESULT_MARKDOWN: '0' } },
    );
    if (!names.length) return ok(offset ? 'No more diagrams at this offset. Restart at offset 0 after directory changes.' : 'No diagrams yet. Create one with diagram_create.');
    return ok(`${names.length} diagram(s) in ${DIAGRAMS_DIR}/:\n${names.map((n) => `- ${n}`).join('\n')}${next === null ? '' : `\nMore diagrams: call diagram_list with offset=${next}.`}`);
  },
};

export { diagramExportTool } from './export.js';
