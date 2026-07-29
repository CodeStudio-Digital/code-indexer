/**
 * Persisted sandbox workdir archive.
 *
 * The archive is session-owned and therefore lives inside the authoritative
 * filesystem bundle:
 *
 *   <session bundle>/checkpoints/sandbox/workdir.tar
 *
 * This module deliberately has no data-dir fallback. Each host process that
 * can run a SandboxManager must wire a bundle resolver backed by its
 * FsSessionStore. An unwired resolver, an unknown session, an unavailable
 * bundle, or a linked path fails closed.
 */

import { lstat, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  assertContainedPath,
  assertPathHasNoLinks,
  atomicWriteFile,
  ensureDirectoryTreeNoLinks,
} from '@mcp/session-storage';

const ARCHIVE_RELATIVE_SEGMENTS = [
  'checkpoints',
  'sandbox',
  'workdir.tar',
] as const;

export interface SandboxArchiveBundleLocation {
  readonly sessionRoot: string;
  readonly bundlePath: string;
}

export interface SandboxArchiveBundleResolver {
  resolveBundle(
    sessionId: string,
  ): Promise<SandboxArchiveBundleLocation | null>;
}

export class SandboxArchiveAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxArchiveAuthorityError';
  }
}

let bundleResolver: SandboxArchiveBundleResolver | null = null;

/**
 * Process-local wiring. Worker threads have their own module realm and must
 * install the resolver independently.
 */
export function setSandboxArchiveBundleResolver(
  resolver: SandboxArchiveBundleResolver | null,
): void {
  bundleResolver = resolver;
}

async function requireBundleLocation(
  sessionId: string,
): Promise<SandboxArchiveBundleLocation> {
  const normalizedId = sessionId.trim();
  if (!normalizedId || normalizedId.includes('\0')) {
    throw new SandboxArchiveAuthorityError('Sandbox session id is invalid');
  }
  if (!bundleResolver) {
    throw new SandboxArchiveAuthorityError(
      'Sandbox archive filesystem authority is not wired',
    );
  }

  const location = await bundleResolver.resolveBundle(normalizedId);
  if (!location) {
    throw new SandboxArchiveAuthorityError(
      `No filesystem session bundle exists for sandbox ${normalizedId}`,
    );
  }

  const sessionRoot = resolve(location.sessionRoot);
  const bundlePath = resolve(location.bundlePath);
  assertContainedPath(sessionRoot, bundlePath);
  await assertPathHasNoLinks(sessionRoot, bundlePath);
  const bundleStat = await lstat(bundlePath);
  if (bundleStat.isSymbolicLink() || !bundleStat.isDirectory()) {
    throw new SandboxArchiveAuthorityError(
      `Sandbox session bundle is not a safe directory: ${bundlePath}`,
    );
  }
  return { sessionRoot, bundlePath };
}

/** Resolve the canonical bundle-local archive path without creating it. */
export async function resolveSandboxArchivePath(
  sessionId: string,
): Promise<string> {
  const { bundlePath } = await requireBundleLocation(sessionId);
  const target = join(bundlePath, ...ARCHIVE_RELATIVE_SEGMENTS);
  assertContainedPath(bundlePath, target);
  return target;
}

/**
 * Return the persisted tar bytes, or `null` for a fresh session. Missing is
 * distinct from unavailable: resolver/root/link failures are always thrown.
 */
export async function loadArchive(sessionId: string): Promise<Buffer | null> {
  const path = await resolveSandboxArchivePath(sessionId);
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SandboxArchiveAuthorityError(
      `Sandbox archive is not a safe regular file: ${path}`,
    );
  }
  const { bundlePath } = await requireBundleLocation(sessionId);
  await assertPathHasNoLinks(bundlePath, path);
  const bytes = await readFile(path);
  return bytes.byteLength > 0 ? bytes : null;
}

/**
 * Atomically replace the session-owned archive. Directory creation rejects
 * symlinks/junctions and the file is fsynced before rename.
 */
export async function saveArchive(
  sessionId: string,
  tar: Buffer,
): Promise<void> {
  const { bundlePath } = await requireBundleLocation(sessionId);
  const path = join(bundlePath, ...ARCHIVE_RELATIVE_SEGMENTS);
  assertContainedPath(bundlePath, path);
  await ensureDirectoryTreeNoLinks(bundlePath, dirname(path));
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new SandboxArchiveAuthorityError(
        `Sandbox archive target is not a safe regular file: ${path}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await atomicWriteFile(path, tar);
}

/** Remove the archive only; deleting a session normally trashes its bundle. */
export async function deleteArchive(sessionId: string): Promise<void> {
  const path = await resolveSandboxArchivePath(sessionId);
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new SandboxArchiveAuthorityError(
        `Sandbox archive is not a safe regular file: ${path}`,
      );
    }
    const { bundlePath } = await requireBundleLocation(sessionId);
    await assertPathHasNoLinks(bundlePath, path);
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
