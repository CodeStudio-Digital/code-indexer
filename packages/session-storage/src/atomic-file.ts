import { randomUUID } from 'node:crypto';
import { copyFile, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { JsonValue, SessionStorageFaultContext, SessionStorageFaultInjector } from './types.js';

const UNSUPPORTED_DIRECTORY_SYNC = new Set(['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM', 'EACCES']);
const TRANSIENT_WINDOWS_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400, 800] as const;

interface RenameRetryOptions {
  readonly platform?: NodeJS.Platform;
  readonly delaysMs?: readonly number[];
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Windows can briefly deny a rename after a fully closed and synced file,
 * commonly while an antivirus/indexer opens the new temp file. Retry only
 * those transient Windows errors; every other failure remains fail-closed.
 */
export async function retryTransientRename(
  operation: () => Promise<void>,
  options: RenameRetryOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const delaysMs = options.delaysMs ?? WINDOWS_RENAME_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? (async (milliseconds) => delay(milliseconds));

  for (let attempt = 0; ; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? '';
      if (
        platform !== 'win32' ||
        !TRANSIENT_WINDOWS_RENAME_ERRORS.has(code) ||
        attempt >= delaysMs.length
      ) {
        throw error;
      }
      await sleep(delaysMs[attempt]);
    }
  }
}

export async function fsyncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC.has((error as NodeJS.ErrnoException)?.code ?? '')) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameDirectory(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

export interface AtomicFileOptions {
  /** Revalidate the caller immediately before every rename, including Windows retries. */
  readonly beforePublish?: () => void;
  readonly mode?: number;
  readonly faultInjector?: SessionStorageFaultInjector;
  readonly context?: Omit<SessionStorageFaultContext, 'point' | 'path'>;
}

async function injectFault(
  options: AtomicFileOptions,
  point: string,
  path: string,
): Promise<void> {
  await options.faultInjector?.({ ...options.context, point, path });
}

export async function durableRename(
  sourcePath: string,
  targetPath: string,
  options: AtomicFileOptions = {},
): Promise<void> {
  const sourceParent = dirname(sourcePath);
  const targetParent = dirname(targetPath);
  await injectFault(options, 'atomic:before-rename', targetPath);
  await retryTransientRename(() => { options.beforePublish?.(); return rename(sourcePath, targetPath); });
  await injectFault(options, 'atomic:after-rename-before-directory-fsync', targetPath);
  await fsyncDirectory(targetParent);
  await injectFault(options, 'atomic:after-target-directory-fsync', targetPath);
  if (!sameDirectory(sourceParent, targetParent)) {
    // A cross-directory rename mutates two directory entries even when both
    // directories are on the same volume (as with session -> .trash). Sync
    // both sides so a power loss cannot resurrect only the source name.
    await fsyncDirectory(sourceParent);
  }
  await injectFault(options, 'atomic:after-directory-fsync', targetPath);
}

export async function atomicWriteFile(
  targetPath: string,
  data: string | Uint8Array,
  options: AtomicFileOptions = {},
): Promise<void> {
  const parent = dirname(targetPath);
  const temporaryPath = join(parent, `.${basename(targetPath)}.tmp-${process.pid}-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', options.mode ?? 0o600);
    await injectFault(options, 'atomic:before-temp-write', targetPath);
    await handle.writeFile(data);
    await injectFault(options, 'atomic:after-temp-write-before-fsync', targetPath);
    await handle.sync();
    await injectFault(options, 'atomic:after-temp-fsync-before-rename', targetPath);
    await handle.close();
    handle = undefined;
    await retryTransientRename(() => { options.beforePublish?.(); return rename(temporaryPath, targetPath); });
    await injectFault(options, 'atomic:after-rename-before-directory-fsync', targetPath);
    await fsyncDirectory(parent);
    await injectFault(options, 'atomic:after-directory-fsync', targetPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Copy a potentially large file without buffering it in JavaScript, then
 * publish it with the same fsync + atomic-rename guarantees as
 * atomicWriteFile. Callers remain responsible for validating the source path.
 */
export async function atomicCopyFile(
  sourcePath: string,
  targetPath: string,
  options: AtomicFileOptions = {},
): Promise<void> {
  const parent = dirname(targetPath);
  const temporaryPath = join(
    parent,
    `.${basename(targetPath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let handle;
  try {
    await injectFault(options, 'atomic:before-temp-write', targetPath);
    await copyFile(sourcePath, temporaryPath);
    handle = await open(temporaryPath, 'r+');
    await injectFault(options, 'atomic:after-temp-write-before-fsync', targetPath);
    await handle.sync();
    await injectFault(options, 'atomic:after-temp-fsync-before-rename', targetPath);
    await handle.close();
    handle = undefined;
    await retryTransientRename(() => { options.beforePublish?.(); return rename(temporaryPath, targetPath); });
    await injectFault(options, 'atomic:after-rename-before-directory-fsync', targetPath);
    await fsyncDirectory(parent);
    await injectFault(options, 'atomic:after-directory-fsync', targetPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function atomicWriteJson(
  targetPath: string,
  value: unknown,
  options: AtomicFileOptions = {},
): Promise<void> {
  await atomicWriteFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, options);
}

function canonicalize(value: unknown, seen: Set<object>): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot contain non-finite numbers');
    return value;
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (typeof value === 'bigint') {
    throw new TypeError('Canonical JSON cannot contain bigint values');
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
  }

  const objectValue = value as object & { toJSON?: () => unknown };
  if (typeof objectValue.toJSON === 'function') {
    return canonicalize(objectValue.toJSON(), seen);
  }
  if (seen.has(objectValue)) throw new TypeError('Canonical JSON cannot contain cycles');
  seen.add(objectValue);
  try {
    if (Array.isArray(objectValue)) {
      return objectValue.map((item) => canonicalize(item, seen) ?? null);
    }
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(objectValue).sort()) {
      const child = canonicalize((objectValue as Record<string, unknown>)[key], seen);
      if (child !== undefined) output[key] = child;
    }
    return output;
  } finally {
    seen.delete(objectValue);
  }
}

export function canonicalJson(value: unknown): string {
  const normalized = canonicalize(value, new Set());
  if (normalized === undefined) throw new TypeError('Value is not representable as canonical JSON');
  return JSON.stringify(normalized);
}
