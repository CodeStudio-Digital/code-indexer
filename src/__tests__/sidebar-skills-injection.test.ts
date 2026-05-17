import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SkillStore } from '@mcp/store/skill-store.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { enrichContentWithActiveSkills } from '@apps/http-api/server/routes/coder/active-skills.js';

describe('enrichContentWithActiveSkills — manual skill picks from sidebar', () => {
  let dir: string;
  let dbPath: string;
  let db: CodeIndexDB;
  let sessionStore: SessionStore;
  let skillStore: SkillStore;
  let sessionId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-active-skills-'));
    dbPath = join(dir, 'test.db');
    db = new CodeIndexDB(dbPath);
    sessionStore = new SessionStore(dbPath);
    skillStore = new SkillStore(dbPath);

    const raw = db.raw();
    raw.prepare(
      `INSERT INTO projects (id, name, root_path, created_at)
       VALUES (1, 'Demo Project', '/srv/demo', datetime('now'))`,
    ).run();
    raw.prepare(
      `INSERT INTO coder_sessions (id, project_id, title, provider, model, created_at)
       VALUES (42, 1, 'sess', 'p', 'm', datetime('now'))`,
    ).run();
    sessionId = 42;
  });

  afterEach(() => {
    skillStore.close();
    sessionStore.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('prepends an <active_skills> block with the picked skill body', async () => {
    skillStore.upsertSkill({
      id: 'docx',
      name: 'DOCX Writer',
      description: 'Author Word documents',
      prompt_body: 'Use the docx library. Always validate the output file.',
    });

    const result = await enrichContentWithActiveSkills(
      'Create a memo about Q4 results.',
      ['docx'],
      sessionId,
      { db, sessionStore, skillStore },
    );

    expect(result.applied).toEqual(['docx']);
    expect(result.missing).toEqual([]);
    expect(result.content.startsWith('<active_skills>\n')).toBe(true);
    expect(result.content).toContain('## docx — DOCX Writer');
    expect(result.content).toContain('Use the docx library.');
    expect(result.content.endsWith('Create a memo about Q4 results.')).toBe(true);
  });

  it('silently skips unknown skill ids and records them as missing', async () => {
    skillStore.upsertSkill({ id: 'pdf', name: 'PDF', prompt_body: 'pdf-body' });

    const result = await enrichContentWithActiveSkills(
      'do it',
      ['pdf', 'does-not-exist'],
      sessionId,
      { db, sessionStore, skillStore },
    );

    expect(result.applied).toEqual(['pdf']);
    expect(result.missing).toEqual(['does-not-exist']);
    expect(result.content).toContain('## pdf — PDF');
    expect(result.content).not.toContain('does-not-exist');
  });

  it('interpolates SESSION_ID, PROJECT_NAME, PROJECT_ROOT placeholders', async () => {
    skillStore.upsertSkill({
      id: 'router',
      name: 'Router',
      prompt_body: 'session=${SESSION_ID} project=${PROJECT_NAME} root=${PROJECT_ROOT}',
    });

    const result = await enrichContentWithActiveSkills(
      'go',
      ['router'],
      sessionId,
      { db, sessionStore, skillStore },
    );

    expect(result.content).toContain('session=42');
    expect(result.content).toContain('project=Demo Project');
    expect(result.content).toContain('root=/srv/demo');
  });

  it('returns the content unchanged when no skill ids are provided', async () => {
    const text = 'plain message';
    const result = await enrichContentWithActiveSkills(text, [], sessionId, {
      db,
      sessionStore,
      skillStore,
    });
    expect(result.content).toBe(text);
    expect(result.applied).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('writes a skill_usage_log row with invoked_by="user" for every applied skill', async () => {
    skillStore.upsertSkill({ id: 'a', name: 'A', prompt_body: 'a' });
    skillStore.upsertSkill({ id: 'b', name: 'B', prompt_body: 'b' });

    await enrichContentWithActiveSkills(
      'multi',
      ['a', 'b'],
      sessionId,
      { db, sessionStore, skillStore },
    );

    const rows = db
      .raw()
      .prepare(
        `SELECT skill_id, invoked_by FROM skill_usage_log
         WHERE session_id = ?
         ORDER BY skill_id`,
      )
      .all(sessionId) as Array<{ skill_id: string; invoked_by: string }>;
    expect(rows).toEqual([
      { skill_id: 'a', invoked_by: 'user' },
      { skill_id: 'b', invoked_by: 'user' },
    ]);
  });

  it('dedupes repeated ids so the block stays deterministic on accidental double-picks', async () => {
    skillStore.upsertSkill({ id: 'once', name: 'Once', prompt_body: 'O' });

    const result = await enrichContentWithActiveSkills(
      'go',
      ['once', 'once', 'once'],
      sessionId,
      { db, sessionStore, skillStore },
    );

    expect(result.applied).toEqual(['once']);
    const occurrences = (result.content.match(/## once — Once/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});
