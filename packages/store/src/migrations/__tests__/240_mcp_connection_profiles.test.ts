import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { mcpConnectionProfiles240 } from '../240_mcp_connection_profiles.js';

/** The main-database api_tokens table as it stands before migration 240. */
function mainDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE api_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      scopes TEXT NOT NULL,
      expires_at INTEGER,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      tier TEXT
    );
  `);
  return db;
}

const insertProfile = (db: Database.Database, id: string, approvalMode = 'controlled') => db.prepare(`
  INSERT INTO mcp_connection_profiles
    (id, name, project_ids, tool_allowlist, agent_allowlist, approval_mode, max_concurrent_runs, max_runtime_ms, created_at, updated_at)
  VALUES (?, ?, '[1,2]', '["search"]', '["build"]', ?, 3, 120000, 1, 1)
`).run(id, `Profile ${id}`, approvalMode);

describe('migration 240 - MCP connection profiles', () => {
  it('persists reusable profile policy and token binding', () => {
    const db = mainDatabase();
    mcpConnectionProfiles240.up(db);

    insertProfile(db, 'claude-build');
    expect(db.prepare('SELECT project_ids, tool_allowlist, agent_allowlist, approval_mode, max_concurrent_runs, max_runtime_ms FROM mcp_connection_profiles WHERE id = ?')
      .get('claude-build')).toEqual({ project_ids: '[1,2]', tool_allowlist: '["search"]', agent_allowlist: '["build"]',
      approval_mode: 'controlled', max_concurrent_runs: 3, max_runtime_ms: 120_000 });

    db.prepare(`
      INSERT INTO api_tokens (id, token_hash, name, scopes, created_at, tier, profile_id)
      VALUES ('token-1', 'hash', 'test', '["mcp:read"]', datetime('now'), 'bootstrap', ?)
    `).run('claude-build');
    expect(db.prepare('SELECT profile_id FROM api_tokens WHERE id = ?').get('token-1')).toEqual({ profile_id: 'claude-build' });

    // Deleting a profile unbinds its tokens instead of deleting them.
    db.prepare('DELETE FROM mcp_connection_profiles WHERE id = ?').run('claude-build');
    expect(db.prepare('SELECT profile_id FROM api_tokens WHERE id = ?').get('token-1')).toEqual({ profile_id: null });
    db.close();
  });

  it('applies the profile defaults and rejects out-of-range policy', () => {
    const db = mainDatabase();
    mcpConnectionProfiles240.up(db);
    db.prepare("INSERT INTO mcp_connection_profiles (id, name, created_at, updated_at) VALUES ('plain', 'Plain', 1, 1)").run();
    expect(db.prepare('SELECT description, project_ids, tool_allowlist, agent_allowlist, approval_mode, max_concurrent_runs, max_runtime_ms FROM mcp_connection_profiles WHERE id = ?')
      .get('plain')).toEqual({ description: '', project_ids: '[]', tool_allowlist: '[]', agent_allowlist: '[]',
      approval_mode: 'controlled', max_concurrent_runs: 2, max_runtime_ms: 1_800_000 });
    expect(() => insertProfile(db, 'bad-mode', 'anything')).toThrow(/CHECK constraint failed/);
    expect(() => db.prepare("INSERT INTO mcp_connection_profiles (id, name, max_concurrent_runs, created_at, updated_at) VALUES ('bad-runs', 'Bad', 17, 1, 1)").run())
      .toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('skips the control-plane schema in trimmed project databases', () => {
    const db = new Database(':memory:');
    mcpConnectionProfiles240.up(db);
    const row = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mcp_connection_profiles'",
    ).get();
    expect(row).toBeUndefined();
    db.close();
  });
});
