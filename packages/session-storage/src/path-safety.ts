import { constants, lstatSync } from 'node:fs';
import { access, lstat, mkdir, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export class UnsafeSessionPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeSessionPathError';
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export function assertContainedPath(basePath: string, candidatePath: string): void {
  const base = resolve(basePath);
  const candidate = resolve(candidatePath);
  const rel = relative(base, candidate);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    return;
  }
  throw new UnsafeSessionPathError(`Path escapes session root: ${candidate}`);
}

export function assertSafeFileName(value: string, label = 'file name'): string {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new UnsafeSessionPathError(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

export async function assertExistingDirectory(path: string, label = 'storage root'): Promise<string> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(`${label} does not exist: ${path}`);
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new UnsafeSessionPathError(`${label} cannot be a symlink or junction: ${path}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
  await access(path, constants.R_OK | constants.W_OK);
  return realpath(path);
}

/**
 * Creates every missing descendant while refusing any existing symbolic link.
 * `trustedRoot` itself must already exist.
 */
export async function ensureDirectoryTreeNoLinks(trustedRoot: string, targetPath: string): Promise<void> {
  const canonicalRoot = await assertExistingDirectory(trustedRoot);
  const target = resolve(targetPath);
  assertContainedPath(canonicalRoot, target);

  const rel = relative(canonicalRoot, target);
  if (rel === '') return;

  let cursor = canonicalRoot;
  for (const segment of rel.split(sep)) {
    assertSafeFileName(segment, 'path segment');
    cursor = resolve(cursor, segment);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) {
        throw new UnsafeSessionPathError(`Symbolic link in session path: ${cursor}`);
      }
      if (!stat.isDirectory()) {
        throw new UnsafeSessionPathError(`Non-directory in session path: ${cursor}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        await mkdir(cursor);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw mkdirError;
        }
        const raced = await lstat(cursor);
        if (raced.isSymbolicLink() || !raced.isDirectory()) {
          throw new UnsafeSessionPathError(
            `Unsafe concurrently-created session path: ${cursor}`,
          );
        }
      }
    }
  }
}

export async function assertPathHasNoLinks(trustedRoot: string, targetPath: string): Promise<void> {
  const canonicalRoot = await assertExistingDirectory(trustedRoot);
  const target = resolve(targetPath);
  assertContainedPath(canonicalRoot, target);

  const rel = relative(canonicalRoot, target);
  if (rel === '') return;

  let cursor = canonicalRoot;
  for (const segment of rel.split(sep)) {
    cursor = resolve(cursor, segment);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) {
      throw new UnsafeSessionPathError(`Symbolic link in session path: ${cursor}`);
    }
  }
}

export function assertPathHasNoLinksSync(trustedRoot: string, targetPath: string): void {
  const root = resolve(trustedRoot);
  const target = resolve(targetPath);
  assertContainedPath(root, target);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new UnsafeSessionPathError(`Unsafe session root: ${root}`);
  }
  const rel = relative(root, target);
  if (rel === '') return;
  let cursor = root;
  for (const segment of rel.split(sep)) {
    cursor = resolve(cursor, segment);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new UnsafeSessionPathError(`Symbolic link in session path: ${cursor}`);
    }
  }
}

/**
 * Permanent cleanup primitive. It deliberately rejects links instead of
 * following or unlinking them, making a poisoned trash bundle fail closed.
 */
export async function removeTreeNoLinks(trustedRoot: string, targetPath: string): Promise<void> {
  const root = resolve(trustedRoot);
  const target = resolve(targetPath);
  assertContainedPath(root, target);
  if (target === root) throw new UnsafeSessionPathError('Refusing to remove the storage root');
  await assertPathHasNoLinks(root, target);
  const targetStat = await lstat(target);
  if (targetStat.isSymbolicLink()) {
    throw new UnsafeSessionPathError(`Refusing to remove symbolic link: ${target}`);
  }
  if (!targetStat.isDirectory()) {
    await unlink(target);
    return;
  }
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const child = resolve(target, entry.name);
    assertContainedPath(target, child);
    if (entry.isSymbolicLink()) {
      throw new UnsafeSessionPathError(`Refusing to traverse symbolic link: ${child}`);
    }
    if (entry.isDirectory()) {
      await removeTreeNoLinks(root, child);
    } else {
      await unlink(child);
    }
  }
  await rmdir(target);
}

const ATOMIC_TEMP_NAME =
  /^\..+\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRITER_TRANSIENT_NAME =
  /^\.writer\.lease\.(?:stale|release|dead-owner)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Collects only names produced by our atomic-write and lease protocols. It
 * runs after the session lease is acquired, so no valid writer can own one of
 * these files. Every link is rejected rather than traversed or unlinked.
 */
export async function collectSessionTransientFiles(
  trustedRoot: string,
): Promise<number> {
  const root = await assertExistingDirectory(trustedRoot, 'session bundle');

  const visit = async (directory: string): Promise<number> => {
    await assertPathHasNoLinks(root, directory);
    let removed = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = resolve(directory, entry.name);
      assertContainedPath(root, child);
      const childStat = await lstat(child);
      if (childStat.isSymbolicLink()) {
        throw new UnsafeSessionPathError(
          `Refusing to inspect symbolic link in session bundle: ${child}`,
        );
      }
      if (childStat.isDirectory()) {
        removed += await visit(child);
        continue;
      }
      if (
        childStat.isFile() &&
        (ATOMIC_TEMP_NAME.test(entry.name) ||
          WRITER_TRANSIENT_NAME.test(entry.name))
      ) {
        await unlink(child);
        removed += 1;
      }
    }
    return removed;
  };

  return visit(root);
}
