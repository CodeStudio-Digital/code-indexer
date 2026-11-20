import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import type { ScannedFile } from '@mcp/shared/types.js';
import { countLines, hashContent } from './content-hash.js';
import { classifyPath } from './mapper.js';
import type { DeferredScannedFile } from './scanner.js';

function readExactBytes(fd: number, size: number): Buffer | undefined {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < bytes.length) {
    const read = readSync(fd, bytes, offset, bytes.length - offset, null);
    if (read === 0) return;
    offset += read;
  }
  return bytes;
}

/** Read the bytes once, using the open file's identity to detect a racing save. */
function readFileSnapshot(path: string, maxBytes: number) {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      // The path can have been replaced by a pipe since discovery.
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      try {
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.size > maxBytes) return;

        const bytes = readExactBytes(fd, Number(before.size));

        const after = statSync(path, { bigint: true, throwIfNoEntry: false });
        if (bytes && after?.isFile() && after.dev === before.dev
            && after.ino === before.ino && after.size === before.size
            && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs) {
          return { content: bytes.toString('utf-8'), sizeBytes: bytes.length, mtimeMs: Number(after.mtimeMs) };
        }
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    // Match discovery's treatment of a new file that is gone or unreadable.
  }
}

/** Backfill targets the committed snapshot. Matching its hash is sufficient even if the path is edited concurrently. */
export function readFileContentByHash(path: string, sizeBytes: number, hash: string): string | undefined {
  try {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== sizeBytes) return;
      const content = readExactBytes(fd, sizeBytes)?.toString('utf-8');
      if (content !== undefined && hashContent(content) === hash) return content;
    } finally {
      closeSync(fd);
    }
  } catch {
    // The file can be unavailable between enumeration and reading.
  }
}

export function readDeferredScannedFile(file: DeferredScannedFile, maxBytes: number): ScannedFile | undefined {
  const snapshot = readFileSnapshot(file.path, maxBytes);
  if (!snapshot) return;

  // A save between discovery and open can change the tier selected by size.
  const classification = snapshot.sizeBytes === file.sizeBytes
    ? undefined
    : classifyPath(file.relativePath, snapshot.sizeBytes);
  if (classification?.tier === 'excluded') return;

  return {
    path: file.path,
    relativePath: file.relativePath,
    ...snapshot,
    tier: classification?.tier ?? file.tier,
    mapperReason: classification?.reason ?? file.mapperReason,
    hash: hashContent(snapshot.content),
    lineCount: countLines(snapshot.content),
  };
}
