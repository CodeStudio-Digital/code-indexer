import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWriteFile, fsyncDirectory, type AtomicFileOptions } from './atomic-file.js';
import { assertPathHasNoLinks, ensureDirectoryTreeNoLinks } from './path-safety.js';

export const transcriptDigest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Content-addressed files are durable before a journal publishes their references. */
export async function writeTranscriptFile(bundle: string, path: string, bytes: Buffer, hash: string, options: AtomicFileOptions) {
  const directory = dirname(path);
  await ensureDirectoryTreeNoLinks(bundle, directory);
  try {
    await assertPathHasNoLinks(bundle, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await atomicWriteFile(path, bytes, options);
    await fsyncDirectory(dirname(directory));
    return;
  }
  if (transcriptDigest(await readFile(path)) !== hash) throw new Error(`Transcript file checksum mismatch: ${path}`);
}
