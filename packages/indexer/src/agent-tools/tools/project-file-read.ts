import { open, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { projectReadPath } from './project-read-path.js';

const MAX_TEXT = 16 * 1024 * 1024;
interface BytePage { offset: number; limit: number; encoding: 'utf8' | 'base64' }
function sameFile(a: Stats, b: Stats) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }

/** Open once, read in bounded chunks, and discard a changed/replaced source.
 * A byte page gives large files a recovery path without loading them in full. */
export async function readProjectFile(root: string, path: string, signal?: AbortSignal, page?: BytePage) {
  const canonical = await projectReadPath(root, path, signal), info = await stat(canonical);
  if (!info.isFile()) throw new Error('Path is a directory or special file; use list_directory for directories');
  signal?.throwIfAborted();
  const handle = await open(canonical, 'r');
  try {
    signal?.throwIfAborted();
    const before = await handle.stat();
    if (!sameFile(info, before)) throw new Error('File changed while opening; retry from the current source');
    if (!before.isFile()) throw new Error('Path is a directory or special file; use list_directory for directories');
    if (!page && before.size > MAX_TEXT) throw new Error('File exceeds the 16 MiB text-read budget; use byte_offset and max_bytes to recover bounded pages');
    let offset = page?.offset ?? 0;
    const limit = page?.limit ?? MAX_TEXT;
    // If an explicit UTF-8 offset splits a codepoint, include its leading bytes.
    if (page?.encoding === 'utf8' && offset > 0 && offset < before.size) {
      const peek = Buffer.alloc(4), start = Math.max(0, offset - 3);
      const { bytesRead } = await handle.read(peek, 0, 4, start);
      let i = offset - start;
      if (i < bytesRead && (peek[i] & 0xc0) === 0x80) {
        while (i > 0 && (peek[i] & 0xc0) === 0x80) i--;
        offset = start + i;
      }
    }
    const buffers: Buffer[] = []; let size = 0;
    while (size < limit && offset + size < before.size) {
      signal?.throwIfAborted();
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit - size, before.size - offset - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset + size);
      signal?.throwIfAborted();
      if (!bytesRead) break;
      buffers.push(buffer.subarray(0, bytesRead)); size += bytesRead;
    }
    let bytes = Buffer.concat(buffers, size);
    if (page?.encoding === 'utf8' && offset + bytes.length < before.size && bytes.length) {
      let i = bytes.length - 1;
      while (i > 0 && (bytes[i] & 0xc0) === 0x80) i--;
      const lead = bytes[i], width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (i + width > bytes.length) bytes = bytes.subarray(0, i);
    }
    const currentPath = await projectReadPath(root, path, signal);
    const after = await handle.stat(), current = await stat(currentPath);
    signal?.throwIfAborted();
    if (!sameFile(before, after) || !sameFile(after, current) || size !== Math.min(limit, Math.max(0, before.size - offset))) {
      throw new Error('File changed while reading; retry from the current source');
    }
    return { content: bytes.toString(page?.encoding ?? 'utf8'), offset, retainedBytes: bytes.length,
      totalBytes: before.size, ...(offset + bytes.length < before.size ? { nextByteOffset: offset + bytes.length } : {}) };
  } finally { await handle.close(); }
}
