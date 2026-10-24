import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createRequire } from 'node:module';
import type { CoderTool } from '../core/tool.js';
import type { ImageBlock } from '../core/messages.js';
import { err } from '../core/tool.js';
import { resolveWorkspacePath } from './paths.js';
import { prepareVisionImage } from '@mcp/services/services/docs/vision-image.js';

const FORMATS: Record<string, string> = { '.mp4': 'mov', '.mov': 'mov', '.m4v': 'mov', '.webm': 'matroska', '.mkv': 'matroska', '.avi': 'avi' };
const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static') as string | null;

export const viewVideo: CoderTool = {
  name: 'view_video',
  description: 'Inspect a local/project video by extracting frames at chosen timestamps (seconds). '
    + 'Use up to 8 frames per call; inspect other timestamps in later calls. Frames are saved and can be revisited with view_image. '
    + 'Supports MP4, MOV, WebM, MKV and AVI. No audio transcription.',
  source: 'native', mutates: false, parallelSafe: false, riskLevel: 'read',
  repeatPolicy: 'volatile',
  timeoutMs: 180_000,
  parameters: { type: 'object', properties: {
    path: { type: 'string' },
    timestamps: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 1, maxItems: 8 },
  }, required: ['path', 'timestamps'], additionalProperties: false },
  handler: async (args, ctx) => {
    try {
      const resolved = resolveWorkspacePath(String(args.path ?? ''), ctx, 'read');
      if (!resolved.ok) return err(resolved.reason);
      const format = FORMATS[extname(resolved.abs).toLowerCase()];
      if (!format) return err('Unsupported video format. Use MP4, MOV, WebM, MKV or AVI.');
      const timestamps = args.timestamps;
      if (!Array.isArray(timestamps) || !timestamps.length || timestamps.length > 8
        || !timestamps.every(t => typeof t === 'number' && Number.isFinite(t) && t >= 0)) return err('Provide 1–8 nonnegative timestamps in seconds.');
      const info = await stat(resolved.abs);
      if (!info.isFile() || info.size > 2 * 1024 ** 3) return err('Video must be a regular file up to 2 GB.');
      if (!ffmpeg) return err('FFmpeg is unavailable on this platform.');
      const executable = ffmpeg.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      const blocks: ImageBlock[] = [];
      for (const timestamp of timestamps) {
        const frame = await new Promise<Buffer>((resolve, reject) => {
          execFile(executable, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1',
            '-protocol_whitelist', 'file,pipe', '-f', format, '-ss', String(timestamp), '-i', resolved.abs,
            '-frames:v', '1', '-an', '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease',
            '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
          { encoding: 'buffer', maxBuffer: 12 * 1024 * 1024, timeout: 20_000, signal: ctx.signal, windowsHide: true },
          (error, stdout) => error ? reject(error) : resolve(stdout));
        });
        if (!frame.length) return err(`No frame at ${timestamp}s. Choose a timestamp within the video duration.`);
        const preview = await prepareVisionImage(frame);
        blocks.push({ type: 'image', name: `${basename(resolved.abs)} @ ${timestamp}s`, mediaType: preview.mediaType, base64: preview.base64 });
      }
      return { content: `Extracted ${blocks.length} frames at ${timestamps.join(', ')} seconds.`, extraUserBlocks: blocks };
    } catch (error) { return err(`view_video: ${error instanceof Error ? error.message : String(error)}`); }
  },
};
