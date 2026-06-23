/**
 * Write tools for the draw.io capability — create a new `.drawio` diagram and
 * replace an existing one. Both validate + normalize the mxGraph XML before
 * touching disk and emit `diagram_changed` so the live editor opens/refreshes.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import {
  fsPort,
  fileExists,
  resolveDiagramPath,
  diagramsDirAbs,
  emitDiagramChanged,
} from './shared.js';
import { validateMxXml } from './validate.js';

export const diagramCreateTool: CoderTool = {
  name: 'diagram_create',
  description:
    'Create a NEW draw.io diagram saved as diagrams/<name>.drawio. Provide draw.io mxGraph XML in `xml` — an <mxfile> (or a bare <mxGraphModel>) whose <root> holds the implicit cells id="0"/id="1" plus your vertices/edges. Fails if a diagram with that name already exists (use diagram_update instead). On success the diagram opens live in the Diagram panel. For complex architecture, build it incrementally: create a first pass, then diagram_read + diagram_update to refine.',
  source: 'native',
  mutates: true,
  parallelSafe: false,
  riskLevel: 'write',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Diagram name — becomes diagrams/<slug>.drawio.' },
      xml: { type: 'string', description: 'The draw.io mxGraph XML for the diagram.' },
      title: { type: 'string', description: 'Optional page title (used when wrapping a bare <mxGraphModel>).' },
    },
    required: ['name', 'xml'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const r = resolveDiagramPath(ctx, String(args.name ?? ''));
    if ('error' in r) return r.error;
    const v = validateMxXml(args.xml, typeof args.title === 'string' ? args.title : undefined);
    if (!v.ok) return err(`Invalid diagram XML: ${v.error}.`);
    const port = fsPort(ctx);
    if (await fileExists(port, r.abs)) {
      return err(`A diagram named "${r.slug}" already exists (${r.rel}). Use diagram_update to modify it.`);
    }
    const dir = diagramsDirAbs(ctx);
    if (dir) await port.mkdir(dir, { recursive: true });
    await port.writeFile(r.abs, v.xml);
    emitDiagramChanged(ctx, r.rel, v.xml);
    return ok(
      `Created ${r.rel} — now open in the Diagram panel. Re-read it with diagram_read "${r.slug}" or change it with diagram_update.`,
    );
  },
};

export const diagramUpdateTool: CoderTool = {
  name: 'diagram_update',
  description:
    'Replace the FULL mxGraph XML of an existing draw.io diagram (this overwrites the file). Read the current XML first with diagram_read, make minimal targeted changes, then send the complete updated XML here. Re-opens it live in the Diagram panel.',
  source: 'native',
  mutates: true,
  parallelSafe: false,
  riskLevel: 'write',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Existing diagram name (diagrams/<slug>.drawio).' },
      xml: { type: 'string', description: 'The complete updated draw.io mxGraph XML.' },
    },
    required: ['name', 'xml'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const r = resolveDiagramPath(ctx, String(args.name ?? ''));
    if ('error' in r) return r.error;
    const port = fsPort(ctx);
    if (!(await fileExists(port, r.abs))) {
      return err(`No diagram named "${r.slug}" (${r.rel}). Use diagram_create to make one, or diagram_list to see existing diagrams.`);
    }
    const v = validateMxXml(args.xml);
    if (!v.ok) return err(`Invalid diagram XML: ${v.error}.`);
    await port.writeFile(r.abs, v.xml);
    emitDiagramChanged(ctx, r.rel, v.xml);
    return ok(`Updated ${r.rel}.`);
  },
};
