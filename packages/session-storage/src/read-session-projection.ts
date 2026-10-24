import { lstat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertContainedPath, assertPathHasNoLinks, UnsafeSessionPathError } from './path-safety.js';
import type { SessionLocator } from './session-locator.js';
import type { SessionLocation, SessionMetadata, SessionState } from './types.js';

/** Bounded metadata refresh; never opens a writer or reads the transcript. */
export async function readSessionProjection(locator: SessionLocator, location: SessionLocation) {
  const expected = locator.locate(location.scope, location.session_id);
  if (resolve(expected.bundle_path) !== resolve(location.bundle_path)
    || resolve(expected.session_root) !== resolve(location.session_root)) {
    throw new UnsafeSessionPathError('Session projection location differs from its resolver');
  }
  assertContainedPath(location.session_root, location.bundle_path);
  await assertPathHasNoLinks(location.session_root, location.bundle_path);
  const directory = await lstat(location.bundle_path);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new UnsafeSessionPathError('Unsafe session projection bundle');
  const read = async <T>(name: string): Promise<T> => {
    const path = join(location.bundle_path, name);
    await assertPathHasNoLinks(location.bundle_path, path);
    const handle = await open(path, 'r');
    try {
      const size = (await handle.stat()).size;
      if (size > 8 * 1024 * 1024) throw new Error('Session projection exceeds its metadata bound');
      const bytes = Buffer.alloc(size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== size) throw new Error('Session projection changed during its read');
      return JSON.parse(bytes.subarray(0, size).toString('utf8')) as T;
    } finally { await handle.close(); }
  };
  const [session, state] = await Promise.all([read<SessionMetadata>('session.json'), read<SessionState>('state.json')]);
  if (session.id !== location.session_id || session.schema_version !== 1 || state.schema_version !== 1) {
    throw new Error('Session projection identity or schema differs');
  }
  return { session, state };
}
