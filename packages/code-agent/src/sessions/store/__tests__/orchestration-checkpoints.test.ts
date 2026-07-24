import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { coderOrchestrationCheckpoints259 } from '@mcp/store/migrations/259_coder_orchestration_checkpoints.js';
import {
  list,
  load,
  renew,
  release,
  save,
  tryAcquire,
} from '../orchestration-checkpoints.js';

const dirs: string[] = [];

function setup(path = ':memory:'): Database.Database {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS coder_sessions (id INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO coder_sessions (id) VALUES (9);
  `);
  coderOrchestrationCheckpoints259.up(db);
  return db;
}

function saveWorkflow(db: Database.Database, payloadJson = '{"id":"wf-1"}', leaseToken?: string): boolean {
  return save(db, {
    sessionId: 9,
    kind: 'workflow',
    scopeId: 'wf-1',
    privacyClass: 'session_private_redacted',
    payloadJson,
    expiresAt: '2099-01-01T00:00:00.000Z',
    leaseToken,
  });
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('orchestration checkpoint CAS', () => {
  it('uses a unique operation token across connections and fences save/release', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-orchestration-'));
    dirs.push(dir);
    const path = join(dir, 'checkpoints.db');
    const first = setup(path);
    const second = new Database(path);
    try {
      expect(saveWorkflow(first)).toBe(true);
      const token = tryAcquire(first, 9, 'workflow', 'wf-1');
      expect(token).toMatch(/^lease:/);

      expect(tryAcquire(first, 9, 'workflow', 'wf-1')).toBeNull();
      expect(tryAcquire(second, 9, 'workflow', 'wf-1')).toBeNull();
      expect(saveWorkflow(second, '{"id":"stale"}')).toBe(false);

      release(second, 9, 'workflow', 'wf-1', 'lease:wrong');
      expect(tryAcquire(second, 9, 'workflow', 'wf-1')).toBeNull();
      expect(saveWorkflow(first, '{"id":"wf-1","status":"running"}', token!)).toBe(true);

      release(first, 9, 'workflow', 'wf-1', token!);
      const next = tryAcquire(second, 9, 'workflow', 'wf-1');
      expect(next).toMatch(/^lease:/);
      release(second, 9, 'workflow', 'wf-1', next!);
    } finally {
      second.close();
      first.close();
    }
  });

  it('expires rows on read and preserves compatibility without migration 259', () => {
    const db = setup();
    expect(save(db, {
      sessionId: 9,
      kind: 'subagent_resume',
      scopeId: 'spawn-1',
      privacyClass: 'session_private_redacted',
      payloadJson: '{}',
      expiresAt: '2026-01-01T00:00:00.000Z',
    })).toBe(true);
    expect(load(db, 9, 'subagent_resume', 'spawn-1', '2026-01-02T00:00:00.000Z')).toBeNull();
    db.close();

    const partial = new Database(':memory:');
    partial.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
    expect(save(partial, {
      sessionId: 9,
      kind: 'workflow',
      scopeId: 'wf',
      privacyClass: 'session_private_redacted',
      payloadJson: '{}',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })).toBe(false);
    expect(tryAcquire(partial, 9, 'workflow', 'wf')).toMatch(/^compat:/);
    partial.close();
  });

  it('fences the stale token after expiry and takeover', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const db = setup();
    expect(saveWorkflow(db)).toBe(true);
    const stale = tryAcquire(db, 9, 'workflow', 'wf-1', 60_000)!;

    vi.setSystemTime(new Date('2026-01-01T00:01:01.000Z'));
    const winner = tryAcquire(db, 9, 'workflow', 'wf-1', 60_000)!;
    expect(winner).toMatch(/^lease:/);
    expect(winner).not.toBe(stale);
    expect(renew(db, 9, 'workflow', 'wf-1', stale, 60_000)).toBe(false);
    expect(saveWorkflow(db, '{"id":"stale-terminal"}', stale)).toBe(false);
    expect(saveWorkflow(db, '{"id":"winner"}', winner)).toBe(true);
    release(db, 9, 'workflow', 'wf-1', winner);
    db.close();
  });

  it('does not let a leased writer recreate a checkpoint after its row disappeared', () => {
    const db = setup();
    expect(saveWorkflow(db)).toBe(true);
    const token = tryAcquire(db, 9, 'workflow', 'wf-1')!;
    db.prepare(`
      DELETE FROM coder_orchestration_checkpoints
      WHERE session_id=9 AND checkpoint_kind='workflow' AND scope_id='wf-1'
    `).run();

    expect(saveWorkflow(db, '{"id":"stale-recreate"}', token)).toBe(false);
    expect(load(db, 9, 'workflow', 'wf-1')).toBeNull();
    db.close();
  });

  it('rejects and deletes checkpoints whose payload integrity metadata was tampered', () => {
    const db = setup();
    expect(saveWorkflow(db)).toBe(true);
    expect(load(db, 9, 'workflow', 'wf-1')?.schemaVersion).toBe(1);

    db.prepare(`
      UPDATE coder_orchestration_checkpoints
      SET payload_json='{"id":"tampered","secret":"injected"}'
      WHERE session_id=9 AND checkpoint_kind='workflow' AND scope_id='wf-1'
    `).run();
    expect(load(db, 9, 'workflow', 'wf-1')).toBeNull();
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM coder_orchestration_checkpoints
    `).get()).toEqual({ count: 0 });

    expect(saveWorkflow(db)).toBe(true);
    db.prepare(`
      UPDATE coder_orchestration_checkpoints
      SET payload_hash='not-the-payload-hash'
      WHERE session_id=9 AND checkpoint_kind='workflow' AND scope_id='wf-1'
    `).run();
    expect(list(db, 9, 'workflow')).toEqual([]);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM coder_orchestration_checkpoints
    `).get()).toEqual({ count: 0 });
    db.close();
  });

  it('never lets a reader delete an active lease, then quarantines it after lease expiry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const db = setup();
    expect(saveWorkflow(db)).toBe(true);
    const token = tryAcquire(db, 9, 'workflow', 'wf-1', 60_000);
    expect(token).toMatch(/^lease:/);
    db.prepare(`
      UPDATE coder_orchestration_checkpoints
      SET payload_hash='corrupt-while-owned'
      WHERE session_id=9 AND checkpoint_kind='workflow' AND scope_id='wf-1'
    `).run();

    const activeNow = '2026-01-01T00:00:30.000Z';
    expect(load(db, 9, 'workflow', 'wf-1', activeNow)).toBeNull();
    expect(list(db, 9, 'workflow', 50, activeNow)).toEqual([]);
    expect(db.prepare(`
      SELECT lease_owner FROM coder_orchestration_checkpoints
      WHERE session_id=9 AND checkpoint_kind='workflow' AND scope_id='wf-1'
    `).get()).toEqual({ lease_owner: token });

    const expiredNow = '2026-01-01T00:01:01.000Z';
    expect(load(db, 9, 'workflow', 'wf-1', expiredNow)).toBeNull();
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM coder_orchestration_checkpoints
      WHERE session_id=9 AND checkpoint_kind='workflow' AND scope_id='wf-1'
    `).get()).toEqual({ count: 0 });
    db.close();
  });
});
