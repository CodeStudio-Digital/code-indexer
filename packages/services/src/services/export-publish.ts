import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import type { ExportOptions } from '@mcp/shared/types.js';

export function exportOutputPath(options: ExportOptions): string {
  if (options.outputPath !== undefined) {
    if (typeof options.outputPath !== 'string' || !options.outputPath.trim() || options.outputPath.includes('\0')) throw new Error('Invalid export output path');
    return options.outputPath;
  }
  const name = options.projectName;
  const safe = !!name && name.length <= 120 && !/[<>:"/\\|?*\x00-\x1f]/.test(name)
    && !/[. ]$/.test(name) && name !== '.' && name !== '..' && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name);
  const filename = safe ? name : `${name.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 64) || 'project'}-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
  return join(mcpDataDir(), 'exports', `${filename}.${options.format === 'json' ? 'json' : 'md'}`);
}

/** Publish once by same-directory rename. Cancellation before commit leaves an
 * existing export intact. After rename succeeds, completion wins cancellation. */
export async function publishExport(path: string, text: string, signal?: AbortSignal, assertCurrent?: () => void): Promise<void> {
  const assertActive = () => { signal?.throwIfAborted(); assertCurrent?.(); };
  assertActive();
  await mkdir(dirname(path), { recursive: true });
  assertActive();
  const temporary = join(dirname(path), `.export-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  let closed = false;
  try {
    assertActive();
    await file.writeFile(text, { encoding: 'utf8', signal });
    await file.sync();
    await file.close(); closed = true;
    assertActive();
    await rename(temporary, path);
  } finally {
    try { if (!closed) await file.close(); }
    finally { await rm(temporary, { force: true }); }
  }
}
