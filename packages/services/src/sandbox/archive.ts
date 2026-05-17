/**
 * Persisted workdir archives — disk I/O helpers shared by the
 * SandboxManager (auto-save on destroy / auto-load on provision) and
 * by HTTP handlers that need to know the canonical path (e.g. the
 * DELETE /sessions route, which removes the file as part of cleanup).
 *
 * Keeping these as free functions (not a class) means the manager can
 * pull them in without depending on anything in `coder/company/` — the
 * sandbox module stays a leaf of the dependency graph.
 *
 * Layout:
 *   <MCP_SANDBOX_ARCHIVE_DIR || cwd()/data/sandboxes>/
 *     └── <sessionId>.tar   ← tar stream produced by
 *                              `ISandboxDriver.exportWorkdir` and
 *                              consumed by `importWorkdir`.
 *
 * Atomicity: writes go to `<path>.tmp` then rename. Readers never see
 * a half-written tar even if the process crashes mid-save.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';

export function archivePath(sessionId: string | number): string {
  const base =
    process.env.MCP_SANDBOX_ARCHIVE_DIR ??
    resolvePath(process.cwd(), 'data', 'sandboxes');
  return join(base, `${sessionId}.tar`);
}

/**
 * Return the tar bytes persisted for `sessionId`, or `null` when no
 * archive exists yet (fresh session) or the file is empty (corrupt
 * write). A missing file is NOT an error — the caller treats it as
 * "no previous state, scaffold fresh".
 */
export async function loadArchive(sessionId: string | number): Promise<Buffer | null> {
  const path = archivePath(sessionId);
  try {
    const buf = await readFile(path);
    return buf.byteLength > 0 ? buf : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Write the tar bytes for `sessionId`, creating parent dirs as needed.
 * Uses tmp+rename for atomicity; on Windows, rename-over-existing can
 * fail, so we fall back to an unlink+rename.
 */
export async function saveArchive(sessionId: string | number, tar: Buffer): Promise<void> {
  const path = archivePath(sessionId);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, tar);
  try {
    await rename(tmpPath, path);
  } catch (e) {
    // Windows: rename fails if target exists. Delete first and retry.
    try {
      await rm(path, { force: true });
      await rename(tmpPath, path);
    } catch {
      throw e;
    }
  }
}

/** Remove the archive file for `sessionId`. No-op when already absent. */
export async function deleteArchive(sessionId: string | number): Promise<void> {
  await rm(archivePath(sessionId), { force: true });
}
