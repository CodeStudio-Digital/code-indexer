import { promises as fs } from 'node:fs';
import { extname } from 'node:path';
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import type { ImageBlock } from '@mcp/code-agent/core/messages.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { resolveWorkspacePath } from '@mcp/code-agent/tools/paths.js';
import { maybeTerse } from '@mcp/code-agent/tools/descriptions.js';

const VIEW_IMAGE_DESC =
  'Load a project image file so you can actually see it on the next turn. ' +
  'The image is appended as a user-visible block; your next prompt observes it like any user attachment.\n' +
  "USE: when the user asked about a screenshot, design asset, or test artifact stored in the project tree.\n" +
  "USE: to inspect a chart/figure your tools just generated.\n" +
  "DON'T: load the same image twice in a session — once it's in the thread you keep seeing it.\n" +
  "DON'T: load images outside the project or explicitly authorized external roots. Paths are validated.\n" +
  'VISION FALLBACK: if your own model can\'t see images, set `describe` to say what you need ' +
  '(e.g. "describe the layout to recreate it" or "list visual bugs / misalignments") — a vision ' +
  'model translates the image to text for you. Ignored when you can already see images.';

const IMAGE_EXT_TO_MEDIA: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

export const viewImage: CoderTool = {
  name: 'view_image',
  description: maybeTerse(VIEW_IMAGE_DESC),
  source: 'native',
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative path, "<project-slug>/..." in a global session, or an authorized absolute image path.' },
      describe: {
        type: 'string',
        description:
          'Optional. What you want described / looked for if your model can\'t see the image (vision fallback). Task-specific, e.g. "detailed layout to recreate" or "evaluate alignment bugs".',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const path = String(args.path ?? '');
    const resolved = resolveWorkspacePath(path, ctx, 'read');
    if (!resolved.ok) return err(resolved.reason);
    const abs = resolved.abs;

    const ext = extname(path).replace(/^\./, '').toLowerCase();
    const mediaType = IMAGE_EXT_TO_MEDIA[ext];
    if (!mediaType) {
      return err(
        `view_image: '${path}' has unsupported extension '.${ext}'. ` +
          `Supported: ${Object.keys(IMAGE_EXT_TO_MEDIA).join(', ')}.`,
      );
    }

    let buf: Buffer;
    try {
      buf = await fs.readFile(abs);
    } catch (e) {
      return err(`view_image: cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (buf.length > MAX_BYTES) {
      return err(`view_image: ${path} is ${(buf.length / 1024 / 1024).toFixed(1)} MB — over the ${MAX_BYTES / 1024 / 1024} MB cap.`);
    }

    const base64 = buf.toString('base64');
    const describeHint = typeof args.describe === 'string' && args.describe.trim() ? args.describe.trim() : undefined;
    const block: ImageBlock = { type: 'image', mediaType, base64, describeHint };

    return {
      content: `Loaded ${path} (${mediaType}, ${(buf.length / 1024).toFixed(1)} KB). The image is now visible to you on the next turn.`,
      extraUserBlocks: [block],
    };
  },
};

export const viewImageTools: CoderTool[] = [viewImage];
