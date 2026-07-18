/**
 * Read tools for the draw.io capability — read one diagram's XML (so the model
 * can edit it surgically), list the saved diagrams, and request an image
 * export. Export is editor-mediated: the tool emits `diagram_export_request`
 * and the live DrawioFrame renders + persists the SVG/PNG (headless export is
 * a future enhancement).
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import {
  fsPort,
  fileExists,
  resolveDiagramPath,
  diagramsDirAbs,
  emitDiagramExportRequest,
  DIAGRAMS_DIR,
} from './shared.js';

export const diagramReadTool: CoderTool = {
  name: 'diagram_read',
  description:
    'Read the complete mxGraph XML of a saved draw.io diagram so you can edit it surgically with diagram_update. Oversized output is preserved by the runner and can be paged with get_tool_output.',
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
    const r = resolveDiagramPath(ctx, String(args.name ?? ''));
    if ('error' in r) return r.error;
    const port = fsPort(ctx);
    let xml: string;
    try {
      xml = await port.readFile(r.abs);
    } catch {
      return err(`No diagram named "${r.slug}" (${r.rel}). Use diagram_list to see existing diagrams.`);
    }
    // The central finalizer owns context shaping and exact spill recovery.
    // Cutting here permanently discarded the XML tail before it could be
    // stored, and duplicated the runner's model-aware cap.
    return ok(xml);
  },
};

export const diagramListTool: CoderTool = {
  name: 'diagram_list',
  description: 'List the draw.io diagrams saved in this project (under diagrams/).',
  source: 'native',
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const dir = diagramsDirAbs(ctx);
    if (!dir) return err('Could not resolve the diagrams directory.');
    const port = fsPort(ctx);
    let names: string[];
    try {
      const entries = await port.readdir(dir, { withFileTypes: true });
      names = entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.drawio'))
        .map((e) => e.name.replace(/\.drawio$/i, ''))
        .sort();
    } catch {
      return ok('No diagrams yet. Create one with diagram_create.');
    }
    if (!names.length) return ok('No diagrams yet. Create one with diagram_create.');
    return ok(`${names.length} diagram(s) in ${DIAGRAMS_DIR}/:\n${names.map((n) => `- ${n}`).join('\n')}`);
  },
};

export const diagramExportTool: CoderTool = {
  name: 'diagram_export',
  description:
    'Export a saved diagram to SVG or PNG, written next to the .drawio file (diagrams/<name>.<format>). Requires the Diagram panel/editor to be OPEN — it asks the live editor to render and persist the image. Use once the diagram looks right, e.g. to embed it in a README or PR.',
  source: 'native',
  mutates: true,
  parallelSafe: false,
  riskLevel: 'write',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Diagram name (diagrams/<slug>.drawio).' },
      format: { type: 'string', enum: ['svg', 'png'], description: 'Image format to export.' },
    },
    required: ['name', 'format'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const r = resolveDiagramPath(ctx, String(args.name ?? ''));
    if ('error' in r) return r.error;
    const port = fsPort(ctx);
    if (!(await fileExists(port, r.abs))) {
      return err(`No diagram named "${r.slug}" (${r.rel}).`);
    }
    const format = args.format === 'png' ? 'png' : 'svg';
    emitDiagramExportRequest(ctx, r.rel, format);
    return ok(
      `Requested ${format.toUpperCase()} export of ${r.rel}. If the Diagram panel is open it writes diagrams/${r.slug}.${format}; otherwise open the diagram first and retry.`,
    );
  },
};
