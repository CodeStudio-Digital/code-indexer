/**
 * The subagent usage a session already counted, by key: the `subagent_runs`
 * of its turn metrics (a tool received the result inside a turn) and the
 * `operation_key` of its standalone usage metrics (received outside a turn).
 * The immutable metrics are the only record, so the set survives restarts;
 * only the session's own writer adds to it. A rolled-back turn keeps its keys:
 * the rollback decides its usage like the rest of that turn.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertContainedPath, assertPathHasNoLinks, type SessionId } from '@mcp/session-storage';
import type { FsSessionDirectory } from './session-directory.js';

const KEYED_METRIC_FILE = /^(?:turn-\d+|subagent-usage-[0-9a-f]+)\.json$/;

function keysOf(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const metric = value as { subagent_runs?: unknown; operation_key?: unknown };
  const keys = Array.isArray(metric.subagent_runs)
    ? metric.subagent_runs.filter((key): key is string => typeof key === 'string')
    : [];
  if (typeof metric.operation_key === 'string') keys.push(metric.operation_key);
  return keys;
}

export async function listAccountedSubagentKeys(
  directory: FsSessionDirectory,
  sessionId: SessionId | string,
): Promise<Set<string>> {
  const entry = await directory.requireEntry(sessionId);
  const root = join(entry.location.bundle_path, 'metrics', 'turns');
  assertContainedPath(entry.location.bundle_path, root);
  let names: string[];
  try {
    await assertPathHasNoLinks(entry.location.bundle_path, root);
    names = (await readdir(root)).filter((name) => KEYED_METRIC_FILE.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
  const keys = new Set<string>();
  for (let offset = 0; offset < names.length; offset += 16) {
    const batch = await Promise.all(names.slice(offset, offset + 16).map(async (name) => {
      const path = join(root, name);
      assertContainedPath(root, path);
      return keysOf(JSON.parse(await readFile(path, 'utf8')));
    }));
    for (const found of batch) for (const key of found) keys.add(key);
  }
  return keys;
}
