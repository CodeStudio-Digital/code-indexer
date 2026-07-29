import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  swapCleanDatabase,
  type DatabaseSwapFaultPoint,
} from '../cleaner.js';

const roots: string[] = [];

function fixture(): {
  root: string;
  dbPath: string;
  cleanDbPath: string;
  walPath: string;
  shmPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'sessions-fs-db-swap-'));
  roots.push(root);
  const dbPath = join(root, 'index.db');
  const cleanDbPath = join(root, '.index.db.clean');
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  writeFileSync(dbPath, 'legacy');
  writeFileSync(cleanDbPath, 'clean');
  writeFileSync(walPath, 'legacy-wal');
  writeFileSync(shmPath, 'legacy-shm');
  return { root, dbPath, cleanDbPath, walPath, shmPath };
}

function expectOriginalRestored(
  dbPath: string,
  cleanDbPath: string,
  walPath: string,
  shmPath: string,
): void {
  expect(readFileSync(dbPath, 'utf8')).toBe('legacy');
  expect(readFileSync(cleanDbPath, 'utf8')).toBe('clean');
  expect(readFileSync(walPath, 'utf8')).toBe('legacy-wal');
  expect(readFileSync(shmPath, 'utf8')).toBe('legacy-shm');
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('database swap fault recovery', () => {
  const points: DatabaseSwapFaultPoint[] = [
    'db-swap:before-source-rename',
    'db-swap:after-source-rename',
    'db-swap:before-sidecar-rename',
    'db-swap:after-sidecar-rename',
    'db-swap:before-clean-rename',
    'db-swap:after-clean-rename',
    'db-swap:before-parent-fsync',
    'db-swap:after-parent-fsync',
  ];

  for (const point of points) {
    it(`restores the original DB when ${point} fails`, () => {
      const { dbPath, cleanDbPath, walPath, shmPath } = fixture();
      let injected = false;

      expect(() => swapCleanDatabase(dbPath, cleanDbPath, 'fault', {
        faultInjector(context) {
          if (!injected && context.point === point) {
            injected = true;
            throw new Error(`injected ${point}`);
          }
        },
      })).toThrow(`injected ${point}`);

      expect(injected).toBe(true);
      expectOriginalRestored(dbPath, cleanDbPath, walPath, shmPath);
      expect(existsSync(`${dbPath}.pre-session-fs-fault`)).toBe(false);
    });
  }

  for (const point of [
    'db-swap:before-sidecar-rename',
    'db-swap:after-sidecar-rename',
  ] as const) {
    it(`restores both sidecars when the second ${point} fails`, () => {
      const { dbPath, cleanDbPath, walPath, shmPath } = fixture();
      let occurrences = 0;

      expect(() => swapCleanDatabase(dbPath, cleanDbPath, 'second-sidecar', {
        faultInjector(context) {
          if (context.point !== point) return;
          occurrences += 1;
          if (occurrences === 2) throw new Error(`injected second ${point}`);
        },
      })).toThrow(`injected second ${point}`);

      expect(occurrences).toBe(2);
      expectOriginalRestored(dbPath, cleanDbPath, walPath, shmPath);
      expect(existsSync(`${dbPath}.pre-session-fs-second-sidecar`)).toBe(false);
    });
  }

  it('keeps the legacy DB recoverable until finalize', () => {
    const { root, dbPath, cleanDbPath, walPath, shmPath } = fixture();
    const swap = swapCleanDatabase(dbPath, cleanDbPath, 'success');

    expect(readFileSync(dbPath, 'utf8')).toBe('clean');
    expect(readFileSync(swap.oldDbPath, 'utf8')).toBe('legacy');
    expect(existsSync(cleanDbPath)).toBe(false);

    swap.rollback();
    expect(readFileSync(dbPath, 'utf8')).toBe('legacy');
    expect(readFileSync(walPath, 'utf8')).toBe('legacy-wal');
    expect(readFileSync(shmPath, 'utf8')).toBe('legacy-shm');
    expect(existsSync(cleanDbPath)).toBe(false);
    expect(readdirSync(root).some((name) => name.startsWith('.index.db.clean.failed-'))).toBe(true);
  });

  it('deletes the legacy DB and sidecars only on finalize', () => {
    const { dbPath, cleanDbPath, walPath, shmPath } = fixture();
    const swap = swapCleanDatabase(dbPath, cleanDbPath, 'finalize');

    swap.finalize();

    expect(readFileSync(dbPath, 'utf8')).toBe('clean');
    expect(existsSync(swap.oldDbPath)).toBe(false);
    expect(existsSync(`${swap.oldDbPath}-wal`)).toBe(false);
    expect(existsSync(`${swap.oldDbPath}-shm`)).toBe(false);
    expect(existsSync(walPath)).toBe(false);
    expect(existsSync(shmPath)).toBe(false);
  });
});
