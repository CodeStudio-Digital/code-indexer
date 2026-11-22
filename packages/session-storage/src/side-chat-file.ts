import { readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWriteJson } from './atomic-file.js';
import { assertPathHasNoLinks, ensureDirectoryTreeNoLinks } from './path-safety.js';
import { asSessionId, type SessionLocation } from './types.js';

function pathFor(root: string, id: string) {
  return join(root, '.side-chats', asSessionId(id) + '.json');
}

export async function readSideChatFile<T>(location: SessionLocation): Promise<T | null> {
  const file = pathFor(location.session_root, location.session_id);
  try {
    await assertPathHasNoLinks(location.session_root, file);
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function writeSideChatFile(location: SessionLocation, value: unknown): Promise<void> {
  const file = pathFor(location.session_root, location.session_id);
  await assertPathHasNoLinks(location.session_root, location.bundle_path);
  await ensureDirectoryTreeNoLinks(location.session_root, dirname(file));
  await atomicWriteJson(file, value);
}

export async function removeSideChatFile(root: string, id: string): Promise<void> {
  const file = pathFor(root, id);
  try {
    await assertPathHasNoLinks(root, file);
    await unlink(file);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
