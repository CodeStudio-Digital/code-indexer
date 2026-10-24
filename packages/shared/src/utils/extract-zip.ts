/**
 * Server-side zip extraction for runtime and skill archives.
 *
 * Safety:
 *   - Path traversal entries (`../`, absolute paths, `..\\`) are rejected.
 *   - Symlinks inside the zip are skipped to prevent destination escape.
 *   - Total uncompressed size is capped (default 500 MB) to prevent
 *     zip bombs from filling the host disk.
 */
import AdmZip from 'adm-zip';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve as resolvePath, sep } from 'node:path';

interface ExtractZipOptions {
  /** Cap total uncompressed bytes (default 500 MB). */
  maxBytes?: number;
  /** When true, wipes the destination folder before extracting. */
  clean?: boolean;
}

interface ExtractZipResult {
  filesWritten: number;
  bytesWritten: number;
  destDir: string;
  /** Files that were rejected (traversal, symlink, oversize). */
  skipped: Array<{ entry: string; reason: string }>;
}

const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

export function extractZipToDir(
  zipPath: string,
  destDir: string,
  opts: ExtractZipOptions = {},
): ExtractZipResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  if (opts.clean && existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }
  mkdirSync(destDir, { recursive: true });

  const destAbs = resolvePath(destDir);
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  let filesWritten = 0;
  let bytesWritten = 0;
  const skipped: Array<{ entry: string; reason: string }> = [];

  for (const entry of entries) {
    const rawName = entry.entryName;
    if (entry.isDirectory) continue;

    if (isUnsafePath(rawName)) {
      skipped.push({ entry: rawName, reason: 'unsafe path (traversal or absolute)' });
      continue;
    }

    const target = resolvePath(join(destAbs, rawName));
    if (!target.startsWith(destAbs + sep) && target !== destAbs) {
      skipped.push({ entry: rawName, reason: 'escapes destination' });
      continue;
    }

    // Skip symlinks (DOS attribute checks; AdmZip exposes attrs).
    // Best-effort: if the upstream attr looks like a symlink, skip.
    const attr = entry.attr ?? 0;
    const isSymlink = ((attr >>> 16) & 0xa000) === 0xa000; // S_IFLNK on POSIX entries
    if (isSymlink) {
      skipped.push({ entry: rawName, reason: 'symlink' });
      continue;
    }

    const data = entry.getData();
    if (bytesWritten + data.length > maxBytes) {
      skipped.push({ entry: rawName, reason: `would exceed maxBytes (${maxBytes})` });
      continue;
    }

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    filesWritten++;
    bytesWritten += data.length;
  }

  return { filesWritten, bytesWritten, destDir: destAbs, skipped };
}

/**
 * Pure helper for path-traversal detection.
 *
 * Reject:
 *   - absolute paths (`/etc/passwd`, `C:\...`)
 *   - any segment that resolves to `..`
 *   - paths that start with `..` after normalisation (Windows or POSIX)
 *
 * Accept everything else; the caller still re-checks via `target.startsWith(destAbs)`
 * as defence in depth.
 */
function isUnsafePath(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return true;
  if (isAbsolute(name)) return true;
  // Unify separators so the check is uniform on both POSIX and Windows.
  const unified = name.replace(/\\/g, '/');
  if (unified.startsWith('/')) return true;
  // Reject ANY path containing a `..` component, even if it would
  // normalise to a safe path. We don't want to follow zip authors into
  // clever-but-pointless reshuffles.
  const components = unified.split('/');
  if (components.some((c) => c === '..')) return true;
  // Defence in depth: also re-check normalised form.
  const norm = normalize(unified);
  if (norm.startsWith('..') || norm.includes('/../') || norm.includes('\\..')) return true;
  return false;
}
