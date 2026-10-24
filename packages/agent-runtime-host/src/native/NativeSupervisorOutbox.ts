import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** A stable private outbox per supervisor connection, within its session store. */
export async function prepareNativeSupervisorOutbox(
  storeRoot: string | undefined,
  connectionId: string,
): Promise<string | undefined> {
  if (storeRoot === undefined) return undefined;
  const directory = join(storeRoot, '.supervisor-outbox',
    createHash('sha256').update(connectionId).digest('hex'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}
