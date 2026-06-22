/**
 * Migration 162 — `coder_turn_telemetry.project_id` is written so per-project
 * usage stats stay queryable from the central DB after sessions move per-project.
 *
 * ABI: needs `pnpm node:rebuild`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRawProjectDb, initProjectSchema } from '@mcp/store/project-db/index.js';
import { record, type RecordTurnTelemetryInput } from '../telemetry-record.js';

const dirs: string[] = [];
function freshDb() {
  const d = mkdtempSync(join(tmpdir(), 'mcp-tel-'));
  dirs.push(d);
  const db = openRawProjectDb(join(d, 'index.db'));
  initProjectSchema(db); // runs migrations incl. 162
  return db;
}
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function minimalInput(sessionId: number | null): RecordTurnTelemetryInput {
  return {
    session_id: sessionId, run_id: 'r1', turn: 1, is_subagent: false,
    provider: 'p', model: 'm', input_tokens: 10, output_tokens: 5,
    cache_read_input_tokens: null, cache_creation_input_tokens: null, thinking_tokens: null,
    history_chars: 100, tool_count: 0, tools_called: [], largest_tool_result_chars: null,
    compaction_triggered: false, summarizer_ran: false, paginate_count: 0,
  };
}

describe('telemetry project_id (mig 162)', () => {
  it('derives project_id from the session on insert', () => {
    const db = freshDb();
    try {
      db.exec(`INSERT INTO projects (id, name, root_path) VALUES (5, 'p5', '/p5')`);
      db.exec(`INSERT INTO coder_sessions (id, project_id, title, provider, model) VALUES (100, 5, 't', 'p', 'm')`);

      const id = record(db, minimalInput(100));
      expect(id).not.toBeNull();
      const row = db.prepare('SELECT project_id, session_id FROM coder_turn_telemetry WHERE id = ?').get(id) as
        { project_id: number | null; session_id: number };
      expect(row.session_id).toBe(100);
      expect(row.project_id).toBe(5); // ← faithful per-project stats

      // The central aggregate can now group by project_id directly.
      const byProject = db.prepare(
        'SELECT SUM(input_tokens) n FROM coder_turn_telemetry WHERE project_id = ?',
      ).get(5) as { n: number };
      expect(byProject.n).toBe(10);
    } finally {
      db.close();
    }
  });

  it('leaves project_id NULL when there is no session (subagent orphan)', () => {
    const db = freshDb();
    try {
      const id = record(db, minimalInput(null));
      const row = db.prepare('SELECT project_id FROM coder_turn_telemetry WHERE id = ?').get(id) as
        { project_id: number | null };
      expect(row.project_id).toBeNull();
    } finally {
      db.close();
    }
  });
});
