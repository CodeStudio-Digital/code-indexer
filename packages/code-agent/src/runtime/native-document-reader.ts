import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import type { ContentBlock } from '@mcp/provider-sdk/wire.js';
import { resolveWorkspacePath, type WorkspacePathContext } from '../tools/paths.js';

/** Materialize only files already granted to the session. The worker owns this
 * reader; no filesystem paths cross the native runtime's attachment contract. */
export function createNativeDocumentReader(context: WorkspacePathContext, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 16 * 1024 * 1024) {
    throw new Error('Native document read budget is invalid');
  }
  const authority = structuredClone(context);
  return async (block: Extract<ContentBlock, { type: 'document' }>, signal?: AbortSignal): Promise<Uint8Array> => {
    signal?.throwIfAborted();
    if (!block.path) throw new Error('Native document has no authorized path');
    const resolved = resolveWorkspacePath(block.path, authority, 'read');
    if (!resolved.ok) throw new Error(`Native document access denied: ${resolved.reason}`);
    const root = await realpath(resolved.rootPath);
    const canonical = await realpath(resolved.abs);
    const inside = relative(root, canonical);
    if (inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || isAbsolute(inside)) {
      throw new Error('Native document escapes its authorized root');
    }
    signal?.throwIfAborted();
    const file = await open(canonical, 'r');
    let bytes: Buffer | undefined;
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
        throw new Error('Native document is empty, not a file, or exceeds its read budget');
      }
      // Recheck the name and identity after opening so a replaced path is not
      // accepted as the file whose grant was checked above.
      const named = await stat(canonical, { bigint: true });
      if (await realpath(resolved.abs) !== canonical || named.dev !== before.dev || named.ino !== before.ino) {
        throw new Error('Native document path changed during authorization');
      }
      bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        signal?.throwIfAborted();
        const result = await file.read(bytes, offset, Math.min(128 * 1024, bytes.length - offset), offset);
        if (!result.bytesRead) throw new Error('Native document changed during reading');
        offset += result.bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
        || await realpath(resolved.abs) !== canonical) {
        throw new Error('Native document changed during reading');
      }
      signal?.throwIfAborted();
      return bytes;
    } catch (cause) {
      bytes?.fill(0);
      throw cause;
    } finally { await file.close(); }
  };
}
