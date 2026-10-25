import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Cross-process exclusion. An abandoned lock is intentionally not stolen: reconcile first. */
export async function lockUltraIntegration(source: string): Promise<() => Promise<void>> {
  const path = join(source, '.mcp-indexer', 'ultra-integration.lock');
  const handle = await open(path, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('Workspace integration is locked by another executor. If that executor crashed, reconcile its changes before removing .mcp-indexer/ultra-integration.lock.');
    throw error;
  });
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(path); throw error; }
  return async () => { await handle.close(); await unlink(path); };
}
