import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { databaseFingerprint } from '../db.js';
import {
  assertNoInterruptedDatabaseSwap,
  commitSwapJournal,
  recoverInterruptedDatabaseSwap,
  writeSwapJournal,
} from '../swap-journal.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): {
  root: string;
  dbPath: string;
  cleanPath: string;
  backupPath: string;
  journalPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'sessions-fs-swap-journal-'));
  roots.push(root);
  const dbPath = join(root, 'index.db');
  const cleanPath = join(root, '.index.db.clean');
  const backupPath = join(root, 'index.db.pre-session-fs-test');
  const runDir = join(root, '.sessions-fs-migrate', 'fingerprint');
  const journalPath = join(runDir, 'database-swaps.json');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(dbPath, 'legacy');
  writeFileSync(cleanPath, 'clean');
  return { root, dbPath, cleanPath, backupPath, journalPath };
}

function journalFor(
  dbPath: string,
  cleanPath: string,
  backupPath: string,
  journalPath: string,
) {
  return writeSwapJournal(journalPath, {
    source_db_path: dbPath,
    source_db_fingerprint: databaseFingerprint(dbPath),
    decision: 'rollback',
    entries: [{
      db_path: dbPath,
      clean_path: cleanPath,
      backup_path: backupPath,
      source_fingerprint: databaseFingerprint(dbPath),
    }],
    bundle_plans: [],
    projects: [],
    data_dir: join(dbPath, '..'),
    run_dir: join(journalPath, '..'),
  });
}

describe('durable database swap journal', () => {
  it('restores the source after a hard stop between source and clean renames', () => {
    const { root, dbPath, cleanPath, backupPath, journalPath } = fixture();
    journalFor(dbPath, cleanPath, backupPath, journalPath);
    renameSync(dbPath, backupPath);

    const result = recoverInterruptedDatabaseSwap(root, dbPath);

    expect(result.kind).toBe('rolled_back');
    expect(readFileSync(dbPath, 'utf8')).toBe('legacy');
    expect(readFileSync(cleanPath, 'utf8')).toBe('clean');
    expect(existsSync(backupPath)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
  });

  it('restores the whole original generation after the clean DB was activated', () => {
    const { root, dbPath, cleanPath, backupPath, journalPath } = fixture();
    journalFor(dbPath, cleanPath, backupPath, journalPath);
    renameSync(dbPath, backupPath);
    renameSync(cleanPath, dbPath);

    recoverInterruptedDatabaseSwap(root, dbPath);

    expect(readFileSync(dbPath, 'utf8')).toBe('legacy');
    expect(readFileSync(cleanPath, 'utf8')).toBe('clean');
  });

  it('finishes deletion only after the validated commit decision is durable', () => {
    const { root, dbPath, cleanPath, backupPath, journalPath } = fixture();
    const journal = journalFor(dbPath, cleanPath, backupPath, journalPath);
    renameSync(dbPath, backupPath);
    renameSync(cleanPath, dbPath);
    commitSwapJournal(journalPath, journal);

    expect(() => assertNoInterruptedDatabaseSwap(root, dbPath)).toThrow(
      'interrupted database swap',
    );
    const result = recoverInterruptedDatabaseSwap(root, dbPath);

    expect(result.kind).toBe('committed');
    expect(readFileSync(dbPath, 'utf8')).toBe('clean');
    expect(existsSync(backupPath)).toBe(false);
    // The caller keeps this until bundle/DB smoke and legacy side cleanup pass.
    expect(existsSync(journalPath)).toBe(true);
  });

  it('rolls back central and project DBs as one journaled generation', () => {
    const { root, dbPath, cleanPath, backupPath, journalPath } = fixture();
    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    const projectDb = join(projectDir, 'index.db');
    const projectClean = join(projectDir, '.index.db.clean');
    const projectBackup = join(projectDir, 'index.db.pre-session-fs-test');
    writeFileSync(projectDb, 'legacy-project');
    writeFileSync(projectClean, 'clean-project');
    writeSwapJournal(journalPath, {
      source_db_path: dbPath,
      source_db_fingerprint: databaseFingerprint(dbPath),
      decision: 'rollback',
      entries: [
        {
          db_path: dbPath,
          clean_path: cleanPath,
          backup_path: backupPath,
          source_fingerprint: databaseFingerprint(dbPath),
        },
        {
          db_path: projectDb,
          clean_path: projectClean,
          backup_path: projectBackup,
          source_fingerprint: databaseFingerprint(projectDb),
        },
      ],
      bundle_plans: [],
      projects: [],
      data_dir: root,
      run_dir: join(root, '.sessions-fs-migrate', 'fingerprint'),
    });
    renameSync(dbPath, backupPath);
    renameSync(cleanPath, dbPath);
    renameSync(projectDb, projectBackup);
    renameSync(projectClean, projectDb);

    recoverInterruptedDatabaseSwap(root, dbPath);

    expect(readFileSync(dbPath, 'utf8')).toBe('legacy');
    expect(readFileSync(projectDb, 'utf8')).toBe('legacy-project');
    expect(readFileSync(cleanPath, 'utf8')).toBe('clean');
    expect(readFileSync(projectClean, 'utf8')).toBe('clean-project');
  });
});
