import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { err } from '@mcp/code-agent/core/tool.js';
import { resolveWorkspacePath } from '@mcp/code-agent/tools/paths.js';
import { prepareVisionImage, MAX_VISION_SOURCE_BYTES, type ImageCrop } from '@mcp/services/services/docs/vision-image.js';
import { viewVideo } from './view-video.js';

export const viewImage: CoderTool = {
  name: 'view_image',
  description: 'Inspect an image from ANY authorized project/local path, or revisit a saved attachment/screenshot by attachment_id. '
    + 'Use action=list to discover saved session images after compaction or restart. Pixels are sent only for the next inference; call again to revisit. '
    + 'Use crop for fine details and max_dimension to control resolution. Supports raster images and SVG. '
    + 'For browser/preview screenshots use the capture tools, then revisit their saved images here.',
  source: 'native', mutates: false, parallelSafe: true, riskLevel: 'read',
  repeatPolicy: 'volatile',
  parameters: {
    type: 'object', properties: {
      action: { type: 'string', enum: ['view', 'list'], description: 'Default view. list returns saved image references without pixels.' },
      path: { type: 'string', description: 'Project-relative, <project-slug>/... or authorized absolute image path.' },
      attachment_id: { type: 'string', description: 'Saved image reference from the conversation or action=list.' },
      crop: { type: 'object', properties: { left: { type: 'integer' }, top: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } }, required: ['left', 'top', 'width', 'height'], additionalProperties: false },
      max_dimension: { type: 'integer', minimum: 64, maximum: 4096, description: 'Longest preview edge, default 2048; original is retained.' },
      offset: { type: 'integer', minimum: 0, description: 'For list, page offset; 50 references per page.' },
      describe: { type: 'string', description: 'What to inspect if a vision fallback model is needed.' },
    }, additionalProperties: false,
  },
  handler: async (args, ctx) => {
    try {
      const store = ctx.toolOutputStore;
      if (args.action === 'list') {
        const images = store?.listImages?.() ?? [];
        const offset = Number(args.offset ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) return err('Invalid list offset.');
        return { content: JSON.stringify({ images: images.slice(offset, offset + 50), total: images.length,
          next_offset: offset + 50 < images.length ? offset + 50 : null }) };
      }
      if (Boolean(args.path) === Boolean(args.attachment_id)) return err('Provide exactly one of path or attachment_id.');
      let bytes: Buffer;
      let name: string;
      let attachmentId: string | null = null;
      if (args.attachment_id) {
        attachmentId = String(args.attachment_id).trim().toLowerCase();
        if (store?.getImage) {
          const image = store.getImage(attachmentId);
          if (!image) return err('Image reference not found in this session. Use action=list.');
          bytes = Buffer.from(image.base64, 'base64');
          name = image.name;
        } else {
          const reference = store?.listImages?.().find(image => image.id === attachmentId);
          if (!reference) return err('Image reference not found in this session. Use action=list.');
          const raw = await store!.get(attachmentId, ctx.signal);
          if (!raw) return err('Image payload not found.');
          const image = JSON.parse(raw) as { base64: string };
          bytes = Buffer.from(image.base64, 'base64');
          name = reference.name;
        }
      } else {
        const resolved = resolveWorkspacePath(String(args.path), ctx, 'read');
        if (!resolved.ok) return err(resolved.reason);
        const stat = await fs.stat(resolved.abs);
        if (!stat.isFile() || stat.size > MAX_VISION_SOURCE_BYTES) return err('Expected an image file up to 64 MB.');
        bytes = await fs.readFile(resolved.abs, { signal: ctx.signal });
        name = basename(resolved.abs);
      }
      const preview = await prepareVisionImage(bytes, { crop: args.crop as ImageCrop | undefined,
        maxDimension: args.max_dimension as number | undefined });
      attachmentId ??= store?.putImage?.({ name, mediaType: 'application/octet-stream', base64: bytes.toString('base64') }) ?? null;
      return {
        content: `Viewing ${name}: original ${preview.width}×${preview.height}, preview ${preview.previewWidth}×${preview.previewHeight}.`
          + (attachmentId ? ` Saved attachment_id=${attachmentId}.` : ''),
        extraUserBlocks: [{ type: 'image', name, mediaType: preview.mediaType, base64: preview.base64,
          ...(attachmentId ? { sourceImageId: attachmentId } : {}),
          ...(typeof args.describe === 'string' ? { describeHint: args.describe } : {}) }],
      };
    } catch (error) { return err(`view_image: ${error instanceof Error ? error.message : String(error)}`); }
  },
};

export const viewImageTools: CoderTool[] = [viewImage, viewVideo];
