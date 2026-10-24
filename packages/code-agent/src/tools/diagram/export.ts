import { randomUUID } from 'node:crypto';
import type { CoderTool } from '../../core/tool.js';
import { err, ok } from '../../core/tool.js';
import { resolveSafe } from '../paths.js';
import { fsPort, resolveDiagramPath } from './shared.js';
import { validateMxXml } from './validate.js';
import { decodeDiagramImage, getDiagramRenderer } from './render-port.js';

export const diagramExportTool: CoderTool = {
  name: 'diagram_export', source: 'native', effectBoundary: 'filesystem', mutates: true, parallelSafe: false, riskLevel: 'write',
  description: 'Render a saved draw.io diagram to a new SVG or PNG next to the source, using the bundled offline editor. Waits for rendering and physical file creation; no open Diagram panel is required. Existing images are preserved: choose a fresh output_name to export another revision. PNG dimensions are limited to 2048 pixels per side; images are limited to 8 MiB.',
  parameters: { type: 'object', properties: {
    name: { type: 'string', description: 'Saved diagram name.' },
    format: { type: 'string', enum: ['svg', 'png'] },
    output_name: { type: 'string', description: 'Optional output basename; defaults to the diagram name. Existing output files cause an error.' },
  }, required: ['name', 'format'], additionalProperties: false },
  handler: async (args, ctx) => {
    ctx.signal?.throwIfAborted();
    if (args.format !== 'svg' && args.format !== 'png') return err('format must be svg or png');
    const source = resolveDiagramPath(ctx, String(args.name ?? ''));
    const output = resolveDiagramPath(ctx, String(args.output_name ?? args.name ?? ''));
    if ('error' in source) return source.error;
    if ('error' in output) return output.error;
    const renderer = getDiagramRenderer(), port = fsPort(ctx);
    if (!renderer) return err('Diagram rendering is available in the desktop app.');
    if (!port.readFileBounded || !port.createFileBytes) return err('Filesystem adapter lacks bounded reads or exclusive image creation.');
    const rel = output.rel.replace(/\.drawio$/, `.${args.format}`), abs = resolveSafe(rel, ctx.cwd);
    if (!abs) return err('Unsafe diagram export path');
    let image: Buffer;
    try {
      const xml = validateMxXml(await port.readFileBounded(source.abs, 4 * 1024 * 1024, ctx.signal));
      if (!xml.ok) return err(`Invalid saved diagram XML: ${xml.error}`);
      image = decodeDiagramImage(await renderer.render({ requestId: randomUUID(), xml: xml.xml, format: args.format }, ctx.signal), args.format);
    } catch (error) {
      ctx.signal?.throwIfAborted();
      return err(`Diagram rendering failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    ctx.signal?.throwIfAborted();
    try { await port.createFileBytes(abs, image); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return err(`${rel} already exists. Choose a fresh output_name; the existing image was preserved.`);
      throw error;
    }
    return ok(`Exported ${rel} (${image.length} bytes).`);
  },
};
