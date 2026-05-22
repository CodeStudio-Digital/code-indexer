import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';

/**
 * Migration 095 added `coder_messages.selected_skill_ids_json` so the runner
 * can rebuild the per-turn `<active_skills>` block instead of inlining the
 * (huge) skill bodies into the persisted user content. This test pins down
 * the store round-trip — without it, a stray serialization detail would
 * silently drop the picks and break the runtime injection on resume.
 */
describe('coder_messages.selected_skill_ids_json round-trip', () => {
  let dir: string;
  let dbPath: string;
  let db: CodeIndexDB;
  let store: SessionStore;
  let sessionId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-selected-skills-'));
    dbPath = join(dir, 'test.db');
    db = new CodeIndexDB(dbPath);
    store = new SessionStore(dbPath);

    const raw = db.raw();
    raw.prepare(
      `INSERT INTO projects (id, name, root_path, created_at)
       VALUES (1, 'Demo', '/srv/demo', datetime('now'))`,
    ).run();
    const session = store.createSession({
      project_id: 1,
      title: 'sess',
      provider: 'anthropic',
      model: 'claude',
    });
    sessionId = session.id;
  });

  afterEach(() => {
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists and hydrates the selectedSkillIds field', () => {
    store.appendMessage(sessionId, {
      role: 'user',
      content: [{ type: 'text', text: 'do a thing' }],
      selectedSkillIds: ['docx', 'pdf'],
    });

    const loaded = store.loadSessionWithMessages(sessionId);
    expect(loaded?.messages[0].selectedSkillIds).toEqual(['docx', 'pdf']);
  });

  it('stores NULL when no skills were picked and hydrates without the field', () => {
    store.appendMessage(sessionId, {
      role: 'user',
      content: [{ type: 'text', text: 'plain' }],
    });

    const raw = db.raw();
    const row = raw
      .prepare('SELECT selected_skill_ids_json FROM coder_messages WHERE session_id = ?')
      .get(sessionId) as { selected_skill_ids_json: string | null };
    expect(row.selected_skill_ids_json).toBeNull();

    const loaded = store.loadSessionWithMessages(sessionId);
    expect(loaded?.messages[0].selectedSkillIds).toBeUndefined();
  });

  it('treats an empty array the same as no picks (NULL on disk)', () => {
    store.appendMessage(sessionId, {
      role: 'user',
      content: [{ type: 'text', text: 'empty picks' }],
      selectedSkillIds: [],
    });

    const raw = db.raw();
    const row = raw
      .prepare('SELECT selected_skill_ids_json FROM coder_messages WHERE session_id = ?')
      .get(sessionId) as { selected_skill_ids_json: string | null };
    expect(row.selected_skill_ids_json).toBeNull();
  });

  it('round-trips picks through loadMessagesBefore (paginated load)', () => {
    const firstId = store.appendMessage(sessionId, {
      role: 'user',
      content: [{ type: 'text', text: 'first' }],
      selectedSkillIds: ['router'],
    });
    store.appendMessage(sessionId, {
      role: 'assistant',
      content: [{ type: 'text', text: 'response' }],
    });
    const lastId = store.appendMessage(sessionId, {
      role: 'user',
      content: [{ type: 'text', text: 'second' }],
      selectedSkillIds: ['docx'],
    });

    const page = store.loadMessagesBefore(sessionId, lastId + 1, 10);
    const userMsgs = page.messages.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(2);
    expect(userMsgs[0].selectedSkillIds).toEqual(['router']);
    expect(userMsgs[1].selectedSkillIds).toEqual(['docx']);
    void firstId;
  });
});
