import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { coderSessionChapters208 } from '@mcp/store/migrations/208_coder_session_chapters.js';
import * as chapters from '../chapters.js';
import * as ops from '../sessions-ops.js';

let db: DB;
let timestamp = 0;

function createSchema(): void {
  db.exec(`
    CREATE TABLE coder_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      last_turn_input_tokens INTEGER NOT NULL DEFAULT 0,
      group_id INTEGER,
      todos_json TEXT,
      cloudcode_session_id TEXT,
      agent TEXT,
      phase_profile_id INTEGER,
      is_global INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      favorited_at TEXT,
      worktree_path TEXT,
      fallback_provider TEXT,
      fallback_model TEXT,
      last_response_id TEXT,
      last_response_message_count INTEGER,
      temperature_override REAL,
      reasoning_effort_override TEXT,
      plan_depth_override TEXT,
      response_language_override TEXT,
      output_style_override TEXT,
      preflight_seed_json TEXT,
      unrestricted_tool_output INTEGER,
      tool_output_cap_level TEXT,
      tool_permission_mode TEXT,
      tool_permission_grants TEXT,
      tool_profile TEXT,
      tool_state_json TEXT,
      summary_boundary_id INTEGER,
      compaction_summary TEXT,
      compaction_count_auto INTEGER NOT NULL DEFAULT 0,
      compaction_count_manual INTEGER NOT NULL DEFAULT 0,
      memory_distilled_message_id INTEGER NOT NULL DEFAULT 0,
      goal_text TEXT,
      goal_status TEXT,
      goal_budget_tokens INTEGER,
      goal_completion_note TEXT,
      goal_created_at TEXT,
      goal_updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE coder_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      is_meta INTEGER NOT NULL DEFAULT 0,
      selected_skill_ids_json TEXT,
      custom_metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE coder_session_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, title)
    );
    CREATE TABLE coder_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      message_id INTEGER
    );
    CREATE TABLE coder_tasks_state (
      session_id INTEGER PRIMARY KEY,
      state TEXT NOT NULL
    );
  `);
  coderSessionChapters208.up(db);
  db.prepare(`
    INSERT INTO coder_sessions (id, project_id, title, provider, model)
    VALUES (1, 10, 'source', 'test-provider', 'test-model')
  `).run();
}

function append(
  role: 'user' | 'assistant' | 'tool',
  text: string,
  opts: { meta?: boolean; skills?: string[] } = {},
): number {
  timestamp += 1;
  const result = db.prepare(`
    INSERT INTO coder_messages (
      session_id, role, content_json,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      is_meta, selected_skill_ids_json, custom_metadata, created_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    role,
    JSON.stringify([{ type: 'text', text }]),
    timestamp * 10,
    timestamp * 11,
    timestamp * 12,
    timestamp * 13,
    opts.meta ? 1 : 0,
    opts.skills ? JSON.stringify(opts.skills) : null,
    JSON.stringify({ marker: text }),
    `2026-01-01 00:00:${String(timestamp).padStart(2, '0')}`,
  );
  return Number(result.lastInsertRowid);
}

function commit(start: number, end: number, expectedBoundary: number, label: string): void {
  const result = chapters.commit(db, {
    sessionId: 1,
    expectedBoundaryId: expectedBoundary,
    startMessageId: start,
    endMessageId: end,
    source: 'auto',
    trigger: 'test',
    title: `Chapter ${label}`,
    chapterJson: JSON.stringify({ chapter: label }),
    chapterText: `Chapter text ${label}`,
    resumeJson: JSON.stringify({ resume: label }),
    resumeText: `Resume ${label}`,
    version: 3,
    metricsJson: JSON.stringify({ label }),
  });
  expect(result.status).toBe('committed');
}

function rawMessages(sessionId: number): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM coder_messages WHERE session_id = ? ORDER BY id')
    .all(sessionId) as Array<Record<string, unknown>>;
}

function withoutIdentity(row: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, session_id: _sessionId, ...rest } = row;
  return rest;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  timestamp = 0;
  createSchema();
});

afterEach(() => db.close());

describe('session operations with conversation chapters', () => {
  it('duplicates the complete raw transcript, mapped chapters and latest resume', () => {
    const ids = [
      append('user', 'archived user', { skills: ['skill-a'] }),
      append('assistant', 'archived assistant', { meta: true }),
    ];
    commit(ids[0], ids[1], 0, 'one');
    ids.push(append('user', 'second user'), append('assistant', 'second assistant'));
    commit(ids[2], ids[3], ids[1], 'two');
    ids.push(append('user', 'visible user'), append('assistant', 'visible assistant'));

    const duplicate = ops.duplicate(db, 1);
    const sourceRows = rawMessages(1);
    const duplicateRows = rawMessages(duplicate.id);

    expect(duplicateRows).toHaveLength(sourceRows.length);
    expect(duplicateRows.map(withoutIdentity)).toEqual(sourceRows.map(withoutIdentity));
    const copiedChapters = chapters.list(db, duplicate.id, { limit: 10 }).items
      .sort((a, b) => a.ordinal - b.ordinal);
    expect(copiedChapters).toHaveLength(2);
    expect(copiedChapters.map((chapter) => ({
      title: chapter.title,
      start: chapter.start_message_id,
      end: chapter.end_message_id,
      json: chapter.chapter_json,
    }))).toEqual([
      {
        title: 'Chapter one',
        start: duplicateRows[0].id,
        end: duplicateRows[1].id,
        json: JSON.stringify({ chapter: 'one' }),
      },
      {
        title: 'Chapter two',
        start: duplicateRows[2].id,
        end: duplicateRows[3].id,
        json: JSON.stringify({ chapter: 'two' }),
      },
    ]);
    expect(duplicate.summary_boundary_id).toBe(duplicateRows[3].id);
    expect(duplicate.compaction_summary).toBe('Resume two');
  });

  it('forks from an archived message inside a chapter and exposes the partial raw tail', () => {
    const first = [append('user', 'chapter one user'), append('assistant', 'chapter one answer')];
    commit(first[0], first[1], 0, 'one');
    const second = [
      append('user', 'chapter two start'),
      append('assistant', 'chapter two progress'),
      append('user', 'edit this request'),
      append('assistant', 'chapter two end'),
    ];
    commit(second[0], second[3], first[1], 'two');
    append('user', 'visible source tail');

    const fork = ops.forkBeforeMessage(db, 1, second[2]);
    const forkRows = rawMessages(fork.session.id);
    const activeChapters = chapters.list(db, fork.session.id, { limit: 10 }).items;

    expect(fork.seed_text).toBe('edit this request');
    expect(forkRows.map((row) => JSON.parse(String(row.content_json))[0].text)).toEqual([
      'chapter one user',
      'chapter one answer',
      'chapter two start',
      'chapter two progress',
    ]);
    expect(activeChapters).toHaveLength(1);
    expect(activeChapters[0].title).toBe('Chapter one');
    expect(fork.session.summary_boundary_id).toBe(forkRows[1].id);
    expect(fork.session.compaction_summary).toBe('Resume one');
    expect(forkRows.filter((row) => Number(row.id) > Number(fork.session.summary_boundary_id)))
      .toHaveLength(2);
  });

  it('supersedes intersecting and later chapters and restores the last surviving resume', () => {
    const first = [append('user', 'one user'), append('assistant', 'one answer')];
    commit(first[0], first[1], 0, 'one');
    const second = [
      append('user', 'two start'),
      append('assistant', 'two progress'),
      append('user', 'rollback target'),
      append('assistant', 'two end'),
    ];
    commit(second[0], second[3], first[1], 'two');
    const third = [append('user', 'three user'), append('assistant', 'three answer')];
    commit(third[0], third[1], second[3], 'three');

    const result = ops.rollbackToMessage(db, 1, second[2]);
    const allChapters = chapters.list(db, 1, { limit: 10, includeSuperseded: true }).items;
    const active = allChapters.filter((chapter) => chapter.superseded_at == null);
    const superseded = allChapters.filter((chapter) => chapter.superseded_at != null);

    expect(result.seed_text).toBe('rollback target');
    expect(rawMessages(1).map((row) => JSON.parse(String(row.content_json))[0].text)).toEqual([
      'one user',
      'one answer',
      'two start',
      'two progress',
    ]);
    expect(active.map((chapter) => chapter.title)).toEqual(['Chapter one']);
    expect(superseded.map((chapter) => chapter.title).sort()).toEqual(['Chapter three', 'Chapter two']);
    expect(result.session.summary_boundary_id).toBe(first[1]);
    expect(result.session.compaction_summary).toBe('Resume one');
  });
});
