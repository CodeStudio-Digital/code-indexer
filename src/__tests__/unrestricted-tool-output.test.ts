/**
 * Unrestricted-tool-output toggle (migration 078).
 *
 * Verifies the per-session flag lifts the per-tool-call truncation caps to a
 * high safety ceiling instead of the production defaults — across every
 * layer that historically capped tool outputs:
 *   - `buildToolResultBlock` (runner.ts) — push-time per-block cap
 *   - `normalizeMessageForCache` (runner.ts) — resume-path re-truncation
 *   - migration 078 schema — adds the column with a NULL default
 *
 * Auto-compaction (PRUNE_MINIMUM/PRUNE_PROTECT) is intentionally NOT under
 * test here because it operates on accumulated history, not per-block, and
 * keeps running with the same defaults regardless of the toggle.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildToolResultBlock,
  normalizeMessageForCache,
} from '@mcp/code-agent/core/runner.js';
import { sessionUnrestrictedToolOutput078 } from '@mcp/store/migrations/078_session_unrestricted_tool_output.js';
import type { AgentMessage } from "@mcp/provider-sdk";

/**
 * Set up a mini in-memory SQLite with just the columns migration 078 needs to
 * touch — enough to verify the column shape and value round-trip without
 * running every prior migration (some depend on tables created elsewhere).
 */
function freshDbWithSessionsTable() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE coder_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL
    );
  `);
  return db;
}

describe('buildToolResultBlock — high cap honours unrestricted ceiling', () => {
  it('leaves a 100 KB output intact when called with the unrestricted main cap', () => {
    const big = 'x'.repeat(100_000);
    const b = buildToolResultBlock('id-1', big, false, 1_000_000);
    expect(b.truncated).toBeUndefined();
    expect(b.content).toBe(big);
  });

  it('still truncates pathological 2 MB output even at the unrestricted ceiling', () => {
    const huge = 'y'.repeat(2_000_000);
    const b = buildToolResultBlock('id-2', huge, false, 1_000_000);
    expect(b.truncated).toBe(true);
    expect(b.originalSize).toBe(2_000_000);
    expect(b.content).toContain('[truncated: original_size=2000000');
  });

  it('preserves marker determinism at the unrestricted ceiling (cache stability)', () => {
    // Two identical raw inputs → identical truncated blocks. Necessary for
    // server-side prefix cache to hit across turns even when the toggle is on.
    const huge = 'z'.repeat(1_500_000);
    const a = buildToolResultBlock('id-3', huge, false, 1_000_000);
    const b = buildToolResultBlock('id-3', huge, false, 1_000_000);
    expect(a.content).toBe(b.content);
  });
});

describe('normalizeMessageForCache — explicit cap arg respected on resume', () => {
  it('does NOT re-truncate a 100 KB legacy block when resumed with the unrestricted cap', () => {
    // Legacy session with the toggle previously enabled persisted a block
    // that's over the production PUSH_TIME_CAP (24k) but under the
    // unrestricted ceiling. On resume, normalize must NOT cut it back to 24k.
    const big = 'a'.repeat(100_000);
    const legacy: AgentMessage = {
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: 'old', content: big }],
    };
    const normalized = normalizeMessageForCache(legacy, 1_000_000);
    const block = normalized.content[0];
    if (block.type !== 'tool_result') throw new Error('expected tool_result');
    expect(block.truncated).toBeUndefined();
    expect(typeof block.content === 'string' ? block.content.length : 0).toBe(100_000);
  });

  it('falls back to PUSH_TIME_CAP when no cap arg is provided (back-compat)', () => {
    // Without a cap arg, behaviour matches the legacy signature: a 30k legacy
    // block IS re-truncated to ~24k on resume.
    const big = 'b'.repeat(30_000);
    const legacy: AgentMessage = {
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: 'old', content: big }],
    };
    const normalized = normalizeMessageForCache(legacy);
    const block = normalized.content[0];
    if (block.type !== 'tool_result') throw new Error('expected tool_result');
    expect(block.truncated).toBe(true);
    expect(block.originalSize).toBe(30_000);
  });
});

describe('migration 078 — coder_sessions.unrestricted_tool_output column', () => {
  it('adds the column as INTEGER with no DEFAULT clause', () => {
    const db = freshDbWithSessionsTable();
    sessionUnrestrictedToolOutput078.up(db);
    const cols = db
      .prepare('PRAGMA table_info(coder_sessions)')
      .all() as Array<{ name: string; type: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'unrestricted_tool_output');
    expect(col).toBeDefined();
    expect(col?.type).toBe('INTEGER');
    // No DEFAULT clause → null on insert unless explicitly set.
    expect(col?.dflt_value).toBeNull();
    db.close();
  });

  it('is idempotent — applying twice does not fail', () => {
    const db = freshDbWithSessionsTable();
    sessionUnrestrictedToolOutput078.up(db);
    expect(() => sessionUnrestrictedToolOutput078.up(db)).not.toThrow();
    db.close();
  });

  it('accepts 0 / 1 / NULL as valid values for the new column', () => {
    const db = freshDbWithSessionsTable();
    sessionUnrestrictedToolOutput078.up(db);
    const insert = db.prepare(
      'INSERT INTO coder_sessions (project_id, title, provider, model, unrestricted_tool_output) VALUES (?, ?, ?, ?, ?)',
    );
    insert.run(1, 's-null', 'p', 'm', null);
    insert.run(1, 's-zero', 'p', 'm', 0);
    insert.run(1, 's-one', 'p', 'm', 1);
    const rows = db
      .prepare('SELECT title, unrestricted_tool_output FROM coder_sessions ORDER BY id')
      .all() as Array<{ title: string; unrestricted_tool_output: number | null }>;
    expect(rows.find((r) => r.title === 's-null')?.unrestricted_tool_output).toBeNull();
    expect(rows.find((r) => r.title === 's-zero')?.unrestricted_tool_output).toBe(0);
    expect(rows.find((r) => r.title === 's-one')?.unrestricted_tool_output).toBe(1);
    db.close();
  });
});
