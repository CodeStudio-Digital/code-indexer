import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { McpConnectionProfileStore } from '../../mcp-connection-profile-store.js';
import { mcpConnectionProfiles240 } from '../240_mcp_connection_profiles.js';

describe('migration 240 - MCP connection profiles', () => {
  it('persists reusable profile policy and token binding', () => {
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

    mcpConnectionProfiles240.up(db);

    const profiles = new McpConnectionProfileStore(db);
    const profile = profiles.upsertProfile({
      id: 'claude-build',
      name: 'Claude build',
      projectIds: [1, 2, 2],
      toolAllowlist: ['search', 'start_agent_run'],
      agentAllowlist: ['build'],
      approvalMode: 'controlled',
      maxConcurrentRuns: 3,
      maxRuntimeMs: 120_000,
    });
    expect(profile.projectIds).toEqual([1, 2]);
    expect(profile.toolAllowlist).toEqual(['search', 'start_agent_run']);

    db.prepare(`
      INSERT INTO api_tokens (id, token_hash, name, scopes, created_at, tier, profile_id)
      VALUES ('token-1', 'hash', 'test', '["mcp:read"]', datetime('now'), 'bootstrap', ?)
    `).run(profile.id);

    expect(
      db.prepare('SELECT profile_id FROM api_tokens WHERE id = ?')
        .get('token-1'),
    ).toEqual({ profile_id: profile.id });
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
