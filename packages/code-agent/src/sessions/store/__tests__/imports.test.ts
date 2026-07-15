import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { coderSessionChapters208 } from '@mcp/store/migrations/208_coder_session_chapters.js';
import { coderCompactionReliability217 } from '@mcp/store/migrations/217_coder_compaction_reliability.js';
import { externalSessionImports225 } from '@mcp/store/migrations/225_external_session_imports.js';
import { ExternalSessionError, type PersistExternalSessionInput } from '../../import/types.js';
import * as imports from '../imports.js';

let db: DB;

function createSchema(): void {
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, root_path TEXT NOT NULL);
    INSERT INTO projects VALUES (1, 'D:\\MCP');
    CREATE TABLE coder_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
      total_input_tokens INTEGER NOT NULL DEFAULT 0, total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_read_tokens INTEGER NOT NULL DEFAULT 0, total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cloudcode_session_id TEXT, agent TEXT, phase_profile_id INTEGER, is_global INTEGER NOT NULL DEFAULT 0,
      summary_boundary_id INTEGER, compaction_summary TEXT, last_response_id TEXT,
      last_response_message_count INTEGER, compaction_count_auto INTEGER NOT NULL DEFAULT 0,
      compaction_count_manual INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE coder_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content_json TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0, is_meta INTEGER NOT NULL DEFAULT 0,
      selected_skill_ids_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE coder_tool_calls (id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL);
  `);
  coderSessionChapters208.up(db);
  coderCompactionReliability217.up(db);
  externalSessionImports225.up(db);
}

function input(title = 'Imported'): PersistExternalSessionInput {
  return {
    project_id: 1, provider: 'openai', model: 'gpt-5', agent: 'build', title,
    source: 'codex',
    reference: { source: 'codex', source_path: 'rollout.jsonl', external_id: 'external-1' },
    document: {
      candidate: {
        source: 'codex', external_id: 'external-1', title, cwd: 'D:\\MCP',
        updated_at: '2026-07-14T11:00:00.000Z', source_model: 'gpt-5', source_path: 'rollout.jsonl', size_bytes: 42,
        reference: { source: 'codex', source_path: 'rollout.jsonl', external_id: 'external-1' },
      },
      messages: [
        { message: { role: 'user', content: [{ type: 'text', text: 'continue' }] }, created_at: '2026-07-14T11:00:01.000Z' },
        { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, created_at: '2026-07-14T11:00:02.000Z' },
      ],
      source_summary: 'Continue.', fingerprint: 'abc',
      stats: { message_count: 2, user_count: 1, assistant_count: 1, tool_call_count: 0, tool_result_count: 0 },
      warnings: [], diagnostics: { adapter: 'codex' },
    },
    summary: {
      version: 3,
      chapter: { title, summary: 'History', user_requests: ['continue'], decisions: [], work_completed: ['done'], files: [], open_issues: [], resolved_issues: [] },
      resume: { objective: 'continue', current_focus: 'continue', constraints: [], pending_tasks: [], next_step: 'continue' },
    },
  };
}

beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); createSchema(); });
afterEach(() => db.close());

describe('external session persistence', () => {
  it('atomically archives the whole transcript and exposes only the handoff live', () => {
    const result = imports.persist(db, input());
    expect(result.imported_messages).toBe(2);
    const session = db.prepare(`SELECT * FROM coder_sessions WHERE id = ?`).get(result.session_id) as Record<string, unknown>;
    expect(session.import_source).toBe('codex');
    expect(session.summary_boundary_id).toBeTruthy();
    expect(session.compaction_summary).toContain('<primary_request>');
    expect(session.total_input_tokens).toBe(0);
    expect(session.total_output_tokens).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) count FROM coder_messages WHERE session_id = ?`).get(result.session_id) as { count: number }).count).toBe(2);
    expect((db.prepare(`SELECT COUNT(*) count FROM coder_messages WHERE session_id = ? AND id > ?`).get(result.session_id, session.summary_boundary_id) as { count: number }).count).toBe(0);
    expect((db.prepare(`SELECT source FROM coder_session_chapters WHERE session_id = ?`).get(result.session_id) as { source: string }).source).toBe('import');
    expect((db.prepare(`SELECT COUNT(*) count FROM coder_tool_calls`).get() as { count: number }).count).toBe(0);
  });

  it('rejects duplicate external identities without creating another session', () => {
    imports.persist(db, input());
    expect(() => imports.persist(db, input())).toThrow(ExternalSessionError);
    expect((db.prepare(`SELECT COUNT(*) count FROM coder_sessions`).get() as { count: number }).count).toBe(1);
  });

  it('rolls back session and messages when chapter creation fails', () => {
    expect(() => imports.persist(db, input(''))).toThrow();
    expect((db.prepare(`SELECT COUNT(*) count FROM coder_sessions`).get() as { count: number }).count).toBe(0);
  });
});
