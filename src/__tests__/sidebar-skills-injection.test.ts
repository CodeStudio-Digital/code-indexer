import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SkillStore } from '@mcp/store/skill-store.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { prepareActiveSkillsBlocks } from '@apps/http-api/server/routes/coder/active-skills.js';

describe('prepareActiveSkillsBlocks — manual skill picks from sidebar', () => {
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

  it('returns interpolated blocks without touching the user input', () => {
    skillStore.upsertSkill({
      id: 'docx',
      name: 'DOCX Writer',
      description: 'Author Word documents',
      prompt_body: 'Use the docx library. Always validate the output file.',
    });

    const result = prepareActiveSkillsBlocks(
      'Create a memo about Q4 results.',
      ['docx'],
      sessionId,
      { db, sessionStore, skillStore },
    );

    expect(result.applied).toEqual(['docx']);
    expect(result.missing).toEqual([]);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toContain('## docx — DOCX Writer');
    expect(result.blocks[0]).toContain('Use the docx library.');
  });

  it('silently skips unknown skill ids and records them as missing', () => {
    skillStore.upsertSkill({ id: 'pdf', name: 'PDF', prompt_body: 'pdf-body' });

    const result = prepareActiveSkillsBlocks(
      'do it',
      ['pdf', 'does-not-exist'],
      sessionId,
      { db, sessionStore, skillStore },
    );

    expect(result.applied).toEqual(['pdf']);
    expect(result.missing).toEqual(['does-not-exist']);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toContain('## pdf — PDF');
    expect(result.blocks.join('\n')).not.toContain('does-not-exist');
  });

  it('interpolates SESSION_ID, PROJECT_NAME, PROJECT_ROOT, USER_INPUT placeholders', () => {
    skillStore.upsertSkill({
      id: 'router',
      name: 'Router',
      prompt_body:
        'session=${SESSION_ID} project=${PROJECT_NAME} root=${PROJECT_ROOT} input=${USER_INPUT}',
    });

    const result = prepareActiveSkillsBlocks(
      'go',
      ['router'],
      sessionId,
      { db, sessionStore, skillStore },
    );

    const body = result.blocks[0];
    expect(body).toContain('session=42');
    expect(body).toContain('project=Demo Project');
    expect(body).toContain('root=/srv/demo');
    expect(body).toContain('input=go');
  });

  it('returns empty blocks when no skill ids are provided', () => {
    const result = prepareActiveSkillsBlocks('plain message', [], sessionId, {
      db,
      sessionStore,
      skillStore,
    });
    expect(result.blocks).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('dedupes repeated ids so the block stays deterministic on accidental double-picks', () => {
    skillStore.upsertSkill({ id: 'once', name: 'Once', prompt_body: 'O' });

    const result = prepareActiveSkillsBlocks(
      'go',
      ['once', 'once', 'once'],
      sessionId,
      { db, sessionStore, skillStore },
    );

    expect(result.applied).toEqual(['once']);
    expect(result.blocks).toHaveLength(1);
  });
});
