import {
  existsSync,
  lstatSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  BundlePlan,
  ProjectRow,
} from './model.js';
import {
  atomicWriteJson,
  readJsonFile,
  syncParentDirectory,
} from './fs-ops.js';
import { databaseFingerprint } from './db.js';

export interface DatabaseSwapJournalEntry {
  db_path: string;
  clean_path: string;
  backup_path: string;
  source_fingerprint: string;
  active_fingerprint?: string;
}

export interface DatabaseSwapJournal {
  format_version: 1;
  source_db_path: string;
  source_db_fingerprint: string;
  decision: 'rollback' | 'commit';
  entries: DatabaseSwapJournalEntry[];
  bundle_plans: BundlePlan[];
  projects: ProjectRow[];
  data_dir: string;
  run_dir: string;
  updated_at: string;
}

function exactFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`swap recovery target is not a regular file: ${path}`);
  }
  return true;
}

function removeExactFile(path: string): void {
  if (!exactFile(path)) return;
  rmSync(path, { force: false });
}

function moveExactFile(source: string, destination: string): void {
  if (!exactFile(source)) return;
  if (existsSync(destination)) {
    throw new Error(`swap recovery destination already exists: ${destination}`);
  }
  renameSync(source, destination);
}

function rollbackEntry(entry: DatabaseSwapJournalEntry): void {
  const dbPath = resolve(entry.db_path);
  const cleanPath = resolve(entry.clean_path);
  const backupPath = resolve(entry.backup_path);
  if (dirname(dbPath) !== dirname(cleanPath) || dirname(dbPath) !== dirname(backupPath)) {
    throw new Error(`swap journal paths do not share a directory: ${dbPath}`);
  }

  const backupExists = exactFile(backupPath);
  const activeExists = exactFile(dbPath);
  const cleanExists = exactFile(cleanPath);
  if (backupExists) {
    // If an active DB exists while the backup also exists, the clean clone was
    // activated. Move it back to its deterministic staging name first.
    if (activeExists) {
      if (cleanExists) {
        throw new Error(
          `cannot recover ${dbPath}: active, clean and backup DBs all exist`,
        );
      }
      renameSync(dbPath, cleanPath);
      for (const suffix of ['-wal', '-shm']) {
        const activeSidecar = `${dbPath}${suffix}`;
        if (!existsSync(activeSidecar)) continue;
        removeExactFile(`${cleanPath}${suffix}`);
        moveExactFile(activeSidecar, `${cleanPath}${suffix}`);
      }
    }
    renameSync(backupPath, dbPath);
    for (const suffix of ['-wal', '-shm']) {
      const backupSidecar = `${backupPath}${suffix}`;
      if (!existsSync(backupSidecar)) continue;
      moveExactFile(backupSidecar, `${dbPath}${suffix}`);
    }
    syncParentDirectory(dbPath);
  } else if (!activeExists) {
    throw new Error(`cannot recover interrupted swap; source and backup are absent: ${dbPath}`);
  }

  const restored = databaseFingerprint(dbPath);
  if (restored !== entry.source_fingerprint) {
    throw new Error(
      `swap rollback restored the wrong source DB at ${dbPath}: expected=${entry.source_fingerprint} actual=${restored}`,
    );
  }
}

function finalizeEntry(entry: DatabaseSwapJournalEntry): void {
  const dbPath = resolve(entry.db_path);
  if (!entry.active_fingerprint) {
    throw new Error(`committed swap journal has no active fingerprint: ${dbPath}`);
  }
  if (!exactFile(dbPath)) throw new Error(`committed clean DB is absent: ${dbPath}`);
  const active = databaseFingerprint(dbPath);
  if (active !== entry.active_fingerprint) {
    throw new Error(
      `committed clean DB fingerprint changed at ${dbPath}: expected=${entry.active_fingerprint} actual=${active}`,
    );
  }
  removeExactFile(entry.backup_path);
  removeExactFile(`${entry.backup_path}-wal`);
  removeExactFile(`${entry.backup_path}-shm`);
  removeExactFile(`${entry.clean_path}-wal`);
  removeExactFile(`${entry.clean_path}-shm`);
  syncParentDirectory(dbPath);
}

export function writeSwapJournal(
  path: string,
  journal: Omit<DatabaseSwapJournal, 'format_version' | 'updated_at'>,
): DatabaseSwapJournal {
  const value: DatabaseSwapJournal = {
    format_version: 1,
    ...journal,
    updated_at: new Date().toISOString(),
  };
  atomicWriteJson(path, value);
  return value;
}

export function commitSwapJournal(
  path: string,
  journal: DatabaseSwapJournal,
): DatabaseSwapJournal {
  const value: DatabaseSwapJournal = {
    ...journal,
    decision: 'commit',
    entries: journal.entries.map((entry) => ({
      ...entry,
      active_fingerprint: databaseFingerprint(entry.db_path),
    })),
    updated_at: new Date().toISOString(),
  };
  atomicWriteJson(path, value);
  return value;
}

export function discardSwapJournal(path: string): void {
  removeExactFile(path);
  syncParentDirectory(path);
}

function journalFiles(parentDirectory: string): string[] {
  const root = join(resolve(parentDirectory), '.sessions-fs-migrate');
  if (!existsSync(root)) return [];
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`migration state root is not a regular directory: ${root}`);
  }
  const output: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name, 'database-swaps.json');
    if (existsSync(path)) output.push(path);
  }
  return output.sort();
}

function readMatchingJournals(
  parentDirectory: string,
  sourceDbPath: string,
): Array<{ path: string; journal: DatabaseSwapJournal }> {
  const expected = resolve(sourceDbPath);
  return journalFiles(parentDirectory).flatMap((path) => {
    const journal = readJsonFile<DatabaseSwapJournal>(path);
    if (journal.format_version !== 1) {
      throw new Error(`unsupported database swap journal: ${path}`);
    }
    return resolve(journal.source_db_path) === expected
      ? [{ path, journal }]
      : [];
  });
}

export function assertNoInterruptedDatabaseSwap(
  parentDirectory: string,
  sourceDbPath: string,
): void {
  const journals = readMatchingJournals(parentDirectory, sourceDbPath);
  if (journals.length > 0) {
    throw new Error(
      `interrupted database swap requires offline --apply recovery: ${journals.map((entry) => entry.path).join(', ')}`,
    );
  }
}

export type SwapRecoveryResult =
  | { kind: 'none' }
  | { kind: 'rolled_back'; journal: DatabaseSwapJournal }
  | {
      kind: 'committed';
      path: string;
      journal: DatabaseSwapJournal;
    };

/**
 * Apply-only recovery. An incomplete generation is rolled all the way back;
 * once the durable commit decision exists, all clean DB fingerprints were
 * already validated and recovery only finishes deleting the old generation.
 */
export function recoverInterruptedDatabaseSwap(
  parentDirectory: string,
  sourceDbPath: string,
): SwapRecoveryResult {
  const journals = readMatchingJournals(parentDirectory, sourceDbPath);
  if (journals.length === 0) return { kind: 'none' };
  if (journals.length > 1) {
    throw new Error(
      `multiple swap journals target the same DB: ${journals.map((entry) => entry.path).join(', ')}`,
    );
  }
  const found = journals[0];
  if (found.journal.decision === 'commit') {
    for (const entry of found.journal.entries) finalizeEntry(entry);
    return {
      kind: 'committed',
      path: found.path,
      journal: found.journal,
    };
  }

  for (const entry of [...found.journal.entries].reverse()) rollbackEntry(entry);
  removeExactFile(found.path);
  syncParentDirectory(found.path);
  return { kind: 'rolled_back', journal: found.journal };
}
