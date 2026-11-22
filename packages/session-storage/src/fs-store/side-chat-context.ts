import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertPathHasNoLinks, type SessionLocation } from '@mcp/session-storage';
import type { FsStoredMessage } from './types.js';

/** Read only the public transcript. In particular, never hydrate attachments,
 * reasoning, replay metadata or the raw pre-processing version of a tool result. */
export async function sideMessageText(location: SessionLocation, row: FsStoredMessage, limit: number) {
  let text = '';
  let truncated = false;
  if (row.is_meta || !Array.isArray(row.content)) return { text, truncated };
  for (const block of row.content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    let part = '';
    if (block.type === 'text' && typeof block.text === 'string') part = block.text;
    if (block.type === 'tool_use') part = String(block.name) + ' ' + JSON.stringify(block.input);
    if (block.type === 'tool_result' && typeof block.content === 'string') part = block.content;
    if (block.type === 'tool_result_ref') {
      const output = block.output;
      const ref = output && typeof output === 'object' && !Array.isArray(output) ? output.shaped : null;
      if (ref && typeof ref === 'object' && !Array.isArray(ref) && typeof ref.relative_path === 'string') {
        const path = resolve(location.bundle_path, ref.relative_path);
        await assertPathHasNoLinks(location.bundle_path, path);
        const file = await open(path, 'r');
        try {
          const bytes = Buffer.alloc(Math.min(limit * 4, Number(ref.size) || limit * 4));
          const read = await file.read(bytes, 0, bytes.length, 0);
          part = bytes.toString('utf8', 0, read.bytesRead);
          truncated ||= read.bytesRead < Number(ref.size);
        } finally { await file.close(); }
      }
    }
    if (!part || part.trim() === '(Image(s) attached from the tool call above.)') continue;
    if (text) text += '\n';
    truncated ||= text.length + part.length > limit;
    text += part.slice(0, Math.max(0, limit - text.length));
    if (text.length >= limit) break;
  }
  return { text, truncated };
}
