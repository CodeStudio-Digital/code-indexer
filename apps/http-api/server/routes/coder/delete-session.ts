import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { removeTreeNoLinks } from '@mcp/session-storage';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import type { SessionId } from '@mcp/agent-runtime-contracts';
import type { ServerDeps } from '../../deps.js';
import type { CoderWorkerPool } from '../../../sse/CoderWorkerPool.js';
import { withSessionLock } from './sessionLock.js';

export class SessionDeletionCleanupError extends Error {
  constructor(readonly deleted: { session_id: SessionId; permanent: false; trash_name: string; scope: import('@mcp/session-storage').SessionStorageScope }, cause: unknown) {
    super(`Conversation removed, but file cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}. Trash: ${deleted.trash_name}`, { cause });
  }
}

/** Only the session-owned output spool lives outside its filesystem bundle. */
export async function removeSessionOutput(sessionId: SessionId): Promise<void> {
  const root = mcpDataDir();
  const output = join(root, 'process-output', createHash('sha256').update(sessionId).digest('hex'));
  try { await removeTreeNoLinks(root, output); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export async function deleteCoderSession(
  sessionId: SessionId,
  permanent: boolean,
  store: ServerDeps['sessionStore'],
  workers: Pick<CoderWorkerPool, 'abort' | 'evict'>,
) {
  return withSessionLock(sessionId, async () => {
    // Project and global workers both hold a filesystem writer lease. Abort
    // alone is cooperative; eviction acknowledges release and isolate exit.
    try { await workers.abort(sessionId); } catch { /* eviction is the stop barrier */ }
    await workers.evict(sessionId);
    if (permanent) await removeSessionOutput(sessionId);
    const trashed = await store.deleteSession(sessionId);
    if (permanent) {
      try { await store.purgeTrashedSession(trashed.location.scope, trashed.trash_name); }
      catch (error) { throw new SessionDeletionCleanupError({ session_id: sessionId, permanent: false,
        trash_name: trashed.trash_name, scope: trashed.location.scope }, error); }
    }
    return {
      session_id: sessionId,
      ...(permanent ? { permanent: true } : {
        trash_name: trashed.trash_name,
        trashed_at: trashed.trashed_at,
        scope: trashed.location.scope,
      }),
    };
  });
}
