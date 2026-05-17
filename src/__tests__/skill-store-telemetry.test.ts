import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SkillStore } from '@mcp/store/skill-store.js';

describe('SkillStore — usage telemetry (migration 056)', () => {
  let dir: string;
  let dbPath: string;
  let db: CodeIndexDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-skill-tel-'));
    dbPath = join(dir, 'test.db');
    db = new CodeIndexDB(dbPath);
    // Seed a project + session so the FK on skill_usage_log resolves.
    // @ts-expect-error - exposing internal db handle for fixture setup
    const raw = db.db;
    raw.prepare(
      `INSERT INTO projects (id, name, root_path, created_at)
       VALUES (1, 'p', '/p', datetime('now'))`,
    ).run();
    raw.prepare(
      `INSERT INTO coder_sessions (id, project_id, title, provider, model, created_at)
       VALUES (1, 1, 't', 'p', 'm', datetime('now'))`,
    ).run();
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists outcome / error_code / agent_run_id and returns aggregate stats', () => {
    const store = new SkillStore(dbPath);
    try {
      store.upsertSkill({ id: 'ds-extractor', name: 'ds-extractor', prompt_body: 'b' });
      store.logSkillUsage({
        session_id: 1,
        skill_id: 'ds-extractor',
        invoked_by: 'system',
        outcome: 'failed',
        error_code: 'vocab.leak',
        agent_run_id: 7,
      });
      store.logSkillUsage({
        session_id: 1,
        skill_id: 'ds-extractor',
        invoked_by: 'system',
        outcome: 'failed',
        error_code: 'vocab.leak',
      });
      store.logSkillUsage({
        session_id: 1,
        skill_id: 'ds-extractor',
        invoked_by: 'system',
        outcome: 'failed',
        error_code: 'props.foreign_vocabulary',
      });
      store.logSkillUsage({
        session_id: 1,
        skill_id: 'ds-extractor',
        invoked_by: 'system',
        outcome: 'success',
      });

      const stats = store.getSkillUsageStats('ds-extractor');
      expect(stats.total_invocations).toBe(4);
      expect(stats.success_rate).toBe(0.25);
      expect(stats.top_error_codes).toEqual([
        { code: 'vocab.leak', count: 2 },
        { code: 'props.foreign_vocabulary', count: 1 },
      ]);
    } finally {
      store.close();
    }
  });

  it('reports success_rate=null when no row carries an outcome (legacy data)', () => {
    const store = new SkillStore(dbPath);
    try {
      store.upsertSkill({ id: 'qa-playwright', name: 'qa-playwright', prompt_body: 'b' });
      store.logSkillUsage({ session_id: 1, skill_id: 'qa-playwright', invoked_by: 'user' });
      store.logSkillUsage({ session_id: 1, skill_id: 'qa-playwright', invoked_by: 'user' });

      const stats = store.getSkillUsageStats('qa-playwright');
      expect(stats.total_invocations).toBe(2);
      expect(stats.success_rate).toBeNull();
      expect(stats.top_error_codes).toEqual([]);
    } finally {
      store.close();
    }
  });
});
