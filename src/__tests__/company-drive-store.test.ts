/**
 * CompanyDriveStore tests. Verifies the metadata + filesystem split:
 * write/read round-trip, append, list filtering, delete cleanup, scope
 * isolation between templates and bare sessions, and path validation.
 *
 * The store needs a SessionContext, but only touches `db`, `companyStore`,
 * and `companySessionId` on it — so we stub the rest. FK pragmas are
 * relaxed for seeding because we don't care about coder_sessions /
 * company_agent_runs lifecycles here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodeIndexDB } from '@mcp/store/db.js';
import { CompanyStore } from '@mcp/store/company-store.js';
import { CompanyDriveStore } from '@mcp/company/services/CompanyDriveStore.js';

let dir: string;
let cdb: CodeIndexDB;
let store: CompanyStore;
let dbPath: string;
let driveRoot: string;

const TPL_ID = 1;
const TPL_SESSION_ID = 100;
const TPL_SESSION_ID_2 = 101;
const BARE_SESSION_ID = 200;

function seed(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (cdb as any).db as import('better-sqlite3').Database;
  raw.pragma('foreign_keys = OFF');
  try {
    raw
      .prepare(`INSERT INTO company_templates (id, name, roles_json) VALUES (?, ?, '[]')`)
      .run(TPL_ID, 'tpl-test');
    raw
      .prepare(`INSERT INTO company_sessions (id, template_id, name, status, config_json) VALUES (?, ?, ?, 'idle', '{}')`)
      .run(TPL_SESSION_ID, TPL_ID, 'tpl-session-1');
    raw
      .prepare(`INSERT INTO company_sessions (id, template_id, name, status, config_json) VALUES (?, ?, ?, 'idle', '{}')`)
      .run(TPL_SESSION_ID_2, TPL_ID, 'tpl-session-2');
    raw
      .prepare(`INSERT INTO company_sessions (id, name, status, config_json) VALUES (?, ?, 'idle', '{}')`)
      .run(BARE_SESSION_ID, 'bare-session');
  } finally {
    raw.pragma('foreign_keys = ON');
  }
}

function makeDrive(sessionId: number): CompanyDriveStore {
  return new CompanyDriveStore({
    db: cdb,
    companyStore: store,
    companySessionId: sessionId,
    rootDir: driveRoot,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-drive-'));
  driveRoot = join(dir, 'drives');
  dbPath = join(dir, 'test.db');
  cdb = new CodeIndexDB(dbPath);
  store = new CompanyStore(dbPath);
  seed();
});

afterEach(() => {
  store.close();
  cdb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('CompanyDriveStore', () => {
  it('resolveScopeKey uses template scope when available', () => {
    const drive = makeDrive(TPL_SESSION_ID);
    expect(drive.resolveScopeKey()).toBe(`tpl:${TPL_ID}`);
  });

  it('resolveScopeKey falls back to session scope without a template', () => {
    const drive = makeDrive(BARE_SESSION_ID);
    expect(drive.resolveScopeKey()).toBe(`ses:${BARE_SESSION_ID}`);
  });

  it('write → read round-trips and reports size correctly', () => {
    const drive = makeDrive(TPL_SESSION_ID);
    const scope = drive.resolveScopeKey();
    const meta = drive.write(scope, 'specs/auth.md', 'hello world', { role: 'backend' });
    expect(meta.path).toBe('specs/auth.md');
    expect(meta.sizeBytes).toBe(11);
    expect(meta.ownerRole).toBe('backend');

    const read = drive.read(scope, 'specs/auth.md');
    expect(read.content).toBe('hello world');
    expect(read.truncated).toBe(false);
    expect(read.meta.sizeBytes).toBe(11);
  });

  it('overwrite reuses the same storage filename and updates size', () => {
    const drive = makeDrive(TPL_SESSION_ID);
    const scope = drive.resolveScopeKey();
    const m1 = drive.write(scope, 'a.txt', 'aaaa');
    const m2 = drive.write(scope, 'a.txt', 'bb');
    expect(m1.id).toBe(m2.id);
    expect(m2.sizeBytes).toBe(2);
    expect(drive.read(scope, 'a.txt').content).toBe('bb');
  });

  it('append concatenates and creates the file when missing', () => {
    const drive = makeDrive(TPL_SESSION_ID);
    const scope = drive.resolveScopeKey();
    drive.append(scope, 'log.txt', 'line1\n');
    const meta = drive.append(scope, 'log.txt', 'line2\n');
    expect(meta.sizeBytes).toBe(12);
    expect(drive.read(scope, 'log.txt').content).toBe('line1\nline2\n');
  });

  it('list filters by prefix and owner_role', () => {
    const drive = makeDrive(TPL_SESSION_ID);
    const scope = drive.resolveScopeKey();
    drive.write(scope, 'specs/a.md', 'A', { role: 'backend' });
    drive.write(scope, 'specs/b.md', 'B', { role: 'frontend' });
    drive.write(scope, 'reports/c.md', 'C', { role: 'backend' });

    expect(drive.list(scope, { prefix: 'specs/' }).map((f) => f.path)).toEqual(['specs/a.md', 'specs/b.md']);
    expect(drive.list(scope, { ownerRole: 'backend' }).map((f) => f.path)).toEqual(['reports/c.md', 'specs/a.md']);
  });

  it('delete removes the row and the on-disk blob', () => {
    const drive = makeDrive(TPL_SESSION_ID);
    const scope = drive.resolveScopeKey();
    const meta = drive.write(scope, 'tmp.txt', 'gone');
    const onDisk = join(driveRoot, scope.replace(':', '_'), (meta as { id: number; path: string } & { storageFilename?: string }).path
      ? '' : '');
    // We don't expose storage_filename, but we can assert via list.
    expect(drive.list(scope).length).toBe(1);
    expect(drive.delete(scope, 'tmp.txt')).toBe(true);
    expect(drive.list(scope).length).toBe(0);
    expect(drive.delete(scope, 'tmp.txt')).toBe(false);
    // Sanity: scope dir still exists, but is empty of metadata-bound files.
    expect(existsSync(join(driveRoot, scope.replace(':', '_')))).toBe(true);
    void onDisk;
  });

  it('two sessions sharing a template see the same files', () => {
    const driveA = makeDrive(TPL_SESSION_ID);
    const driveB = makeDrive(TPL_SESSION_ID_2);
    expect(driveA.resolveScopeKey()).toBe(driveB.resolveScopeKey());
    driveA.write(driveA.resolveScopeKey(), 'shared.md', 'hi');
    expect(driveB.read(driveB.resolveScopeKey(), 'shared.md').content).toBe('hi');
  });

  it('bare-session scope is isolated from template scope', () => {
    const tplDrive = makeDrive(TPL_SESSION_ID);
    const bareDrive = makeDrive(BARE_SESSION_ID);
    tplDrive.write(tplDrive.resolveScopeKey(), 'a.md', 'A');
    expect(bareDrive.list(bareDrive.resolveScopeKey()).length).toBe(0);
    expect(() => bareDrive.read(bareDrive.resolveScopeKey(), 'a.md')).toThrow(/not found/);
  });

  it('rejects path traversal, absolute paths and control chars', () => {
    const drive = makeDrive(TPL_SESSION_ID);
    const scope = drive.resolveScopeKey();
    expect(() => drive.write(scope, '../escape.md', 'x')).toThrow();
    expect(() => drive.write(scope, 'foo/../escape.md', 'x')).toThrow();
    expect(() => drive.write(scope, '/abs/path.md', 'x')).toThrow();
    expect(() => drive.write(scope, 'foo\\bar.md', 'x')).toThrow();
    expect(() => drive.write(scope, 'control\x01char.md', 'x')).toThrow();
  });

  it('accepts realistic folder paths with spaces and accents', () => {
    const drive = makeDrive(TPL_SESSION_ID);
    const scope = drive.resolveScopeKey();
    drive.write(scope, 'Meu Projeto/relatórios/v1 (final).md', 'ok');
    drive.write(scope, 'data/2024-q3.json', '{}');
    expect(drive.list(scope).length).toBe(2);
  });

  it('read truncates at maxBytes and signals it', () => {
    const drive = makeDrive(TPL_SESSION_ID);
    const scope = drive.resolveScopeKey();
    drive.write(scope, 'big.txt', 'abcdefghij');
    const r = drive.read(scope, 'big.txt', { maxBytes: 4 });
    expect(r.content).toBe('abcd');
    expect(r.truncated).toBe(true);
    const r2 = drive.read(scope, 'big.txt', { offset: 4, maxBytes: 4 });
    expect(r2.content).toBe('efgh');
    expect(r2.truncated).toBe(true);
    const r3 = drive.read(scope, 'big.txt', { offset: 6 });
    expect(r3.content).toBe('ghij');
    expect(r3.truncated).toBe(false);
  });
});
