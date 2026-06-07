import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';

/**
 * Duplicating a session should clone its Session Drive memory notes
 * (coder_session_memory) so the copy keeps the same working memory — not just
 * the message transcript. Investigations are project-scoped and intentionally
 * NOT copied (the clone recalls them via project scope already).
 */
describe('duplicateSession copies Drive memory', () => {
  let dir: string;
  let dbPath: string;
  let db: CodeIndexDB;
  let store: SessionStore;
  let sessionId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-dup-memory-'));
    dbPath = join(dir, 'test.db');
    db = new CodeIndexDB(dbPath);
    store = new SessionStore(dbPath);
    db.raw().prepare(
      `INSERT INTO projects (id, name, root_path, created_at)
       VALUES (1, 'Demo', '/srv/demo', datetime('now'))`,
    ).run();
    sessionId = store.createSession({
      project_id: 1, title: 'sess', provider: 'anthropic', model: 'claude',
    }).id;
  });

  afterEach(() => {
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('clones the memory notes (kind + pin preserved) along with messages', () => {
    store.rememberMemory(sessionId, { title: 'decision-x', body: 'use boundary', kind: 'decision', pinned: true });
    store.rememberMemory(sessionId, { title: 'todo-y', body: 'wire the UI', kind: 'todo' });
    store.appendMessage(sessionId, { role: 'user', content: [{ type: 'text', text: 'hi' }] });

    const dup = store.duplicateSession(sessionId);

    const notes = store.listSessionMemory(dup.id);
    expect(notes).toHaveLength(2);
    const byTitle = Object.fromEntries(notes.map((n) => [n.title, n]));
    expect(byTitle['decision-x'].body).toBe('use boundary');
    expect(byTitle['decision-x'].kind).toBe('decision');
    expect(byTitle['decision-x'].pinned).toBe(1);
    expect(byTitle['todo-y'].pinned).toBe(0);

    // Transcript still copied; source left intact.
    expect(store.loadSessionWithMessages(dup.id)?.messages).toHaveLength(1);
    expect(store.listSessionMemory(sessionId)).toHaveLength(2);
  });

  it('clone and source notes are independent after duplication', () => {
    store.rememberMemory(sessionId, { title: 'n', body: 'orig' });
    const dup = store.duplicateSession(sessionId);

    // Editing the clone's note (same title) must not touch the source.
    store.rememberMemory(dup.id, { title: 'n', body: 'edited-in-clone' });
    expect(store.listSessionMemory(sessionId)[0].body).toBe('orig');
    expect(store.listSessionMemory(dup.id)[0].body).toBe('edited-in-clone');
  });

  it('a session with no notes duplicates cleanly (zero copied)', () => {
    expect(store.copySessionMemory(sessionId, store.duplicateSession(sessionId).id)).toBe(0);
  });
});
