import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { replaceAppSeedFile, validateAppSeedSql } from '../database/seed.js';

let workspace: string | null = null;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

describe('App Studio canonical seed contract', () => {
  it('accepts retry-safe inserts', () => {
    expect(validateAppSeedSql("INSERT OR IGNORE INTO clubes (id, nome) VALUES (1, 'Aurora');")).toBeNull();
    expect(validateAppSeedSql("INSERT INTO clubes (id, nome) VALUES (1, 'Aurora') ON CONFLICT(id) DO UPDATE SET nome=excluded.nome;")).toBeNull();
    expect(validateAppSeedSql("INSERT OR IGNORE INTO clubes (id, nome) VALUES (1, 'Use DROP; only as documentation');")).toBeNull();
  });

  it('rejects destructive, schema and non-idempotent statements', () => {
    expect(validateAppSeedSql("DELETE FROM clubes; INSERT OR IGNORE INTO clubes(id) VALUES (1);")).toContain('every seed statement');
    expect(validateAppSeedSql('CREATE TABLE clubes(id INTEGER);')).toContain('every seed statement');
    expect(validateAppSeedSql("UPDATE clubes SET nome = 'X';")).toContain('every seed statement');
    expect(validateAppSeedSql("INSERT INTO clubes(id) VALUES (1);")).toContain('every seed statement');
  });

  it('replaces the canonical seed with a backup and stays idempotent', () => {
    workspace = mkdtempSync(join(tmpdir(), 'app-seed-'));
    mkdirSync(join(workspace, 'seeds'), { recursive: true });
    writeFileSync(join(workspace, 'seeds', 'seed.sql'), "INSERT INTO clubes(id) VALUES (1);\n", 'utf8');
    const canonical = "INSERT OR IGNORE INTO clubes(id) VALUES (1);";

    const first = replaceAppSeedFile(workspace, canonical);
    expect(first.changed).toBe(true);
    expect(first.backup_path).toBeTruthy();
    expect(readFileSync(first.backup_path!, 'utf8')).toContain('INSERT INTO clubes');
    expect(readFileSync(join(workspace, 'seeds', 'seed.sql'), 'utf8')).toBe(`${canonical}\n`);

    const second = replaceAppSeedFile(workspace, canonical);
    expect(second.changed).toBe(false);
    expect(second.backup_path).toBeNull();
  });
});
