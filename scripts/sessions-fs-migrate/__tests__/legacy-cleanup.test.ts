import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupLegacySessionSideStores } from '../legacy-cleanup.js';
import type { BundlePlan } from '../model.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('legacy side-store cleanup', () => {
  it('removes the central sandbox tar only when final cleanup is invoked', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-side-cleanup-'));
    cleanup.push(root);
    const dataDir = join(root, 'data');
    const migrationRunDir = join(dataDir, '.sessions-fs-migration', 'run');
    const archive = join(dataDir, 'sandboxes', '3.tar');
    mkdirSync(migrationRunDir, { recursive: true });
    mkdirSync(join(dataDir, 'sandboxes'), { recursive: true });
    writeFileSync(archive, 'legacy-workdir');

    const plan: BundlePlan = {
      identity: { kind: 'company', id: 3 },
      uuid: '00000000-0000-4000-8000-000000000003',
      scope: 'global',
      finalDir: join(dataDir, 'sessions', 'global', 'bundle'),
      stagingDir: join(dataDir, 'sessions', 'global', '.migrating-bundle'),
    };

    expect(existsSync(archive)).toBe(true);
    const report = cleanupLegacySessionSideStores(
      dataDir,
      [plan],
      migrationRunDir,
    );
    expect(existsSync(archive)).toBe(false);
    expect(report.removedFiles).toBe(1);
  });

  it('removes the obsolete pre-split SQLite backup only during final cleanup', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-pre-split-cleanup-'));
    cleanup.push(root);
    const dataDir = join(root, 'data');
    const migrationRunDir = join(dataDir, '.sessions-fs-migration', 'run');
    const dbPath = join(dataDir, 'index.db');
    const backup = `${dbPath}.pre-split.bak`;
    mkdirSync(migrationRunDir, { recursive: true });
    writeFileSync(backup, 'legacy-db-with-sessions');
    writeFileSync(`${backup}.meta.json`, '{}');

    const report = cleanupLegacySessionSideStores(
      dataDir,
      [],
      migrationRunDir,
      dbPath,
    );

    expect(existsSync(backup)).toBe(false);
    expect(existsSync(`${backup}.meta.json`)).toBe(false);
    expect(report.removedFiles).toBe(2);
  });
});
