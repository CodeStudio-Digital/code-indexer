/**
 * One-time pre-split backup of the central DB (plan §9.2).
 *
 * Taken once, before the first destructive purge in a session. Since purge is
 * deferred by default the backup is a belt-and-suspenders safety net: a
 * checkpointed, self-contained snapshot of the monolith to roll back to.
 *
 * Only touches files under the central data dir (git-ignored) — never the
 * user's working tree, never git (see memory feedback_git_stash_disaster).
 */
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { DB } from '../db/types.js';

export function backupPathFor(centralDbPath: string): string {
  return `${centralDbPath}.pre-split.bak`;
}

/**
 * Ensure a one-time backup exists. Returns the backup path (existing or new).
 * `schemaVersion` is recorded in a sidecar for auditability.
 */
export function ensureCentralBackup(central: DB, centralDbPath: string, schemaVersion: number): string {
  const bak = backupPathFor(centralDbPath);
  if (existsSync(bak)) return bak;
  const temporary = `${bak}.${randomUUID()}.tmp`;
  try {
    // SQLite includes committed WAL frames even when another reader holds a snapshot.
    central.prepare('VACUUM INTO ?').run(temporary);
    if (!existsSync(bak)) renameSync(temporary, bak);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
  try {
    writeFileSync(
      `${bak}.meta.json`,
      JSON.stringify({ schemaVersion, createdAtIso: 'pre-split', source: centralDbPath }, null, 2),
    );
  } catch {
    /* sidecar is advisory */
  }
  return bak;
}
