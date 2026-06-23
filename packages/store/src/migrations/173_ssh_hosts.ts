/**
 * Migration 173 — embedded SSH client (Termius-style), project-scoped.
 *
 *   - ssh_identities    → reusable credentials (a key or password + default user)
 *   - ssh_hosts         → saved connections (host/port/user/auth, jump host,
 *                          groups/tags, agent forwarding, known-host pin)
 *   - ssh_snippets      → saved commands runnable on a host (P6)
 *   - ssh_port_forwards → local/remote/dynamic tunnels per host (P5)
 *
 * Secrets (`enc_*` columns) are encrypted by the renderer with the OS keychain
 * (Electron `safeStorage`) before they reach the store, which persists only the
 * opaque tagged blob. NOTE: on a machine with NO OS keychain (rare bare Linux),
 * `safeStorage` is unavailable and the shim falls back to a `plain:<base64>`
 * blob — obfuscated, NOT encrypted-at-rest. All tables are project-scoped (the
 * IDE mounts hosts inside the open project).
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS) — mirrors apiDocPagesExamples172. FK
 * cascade only fires when PRAGMA foreign_keys is ON, so the store also deletes
 * children explicitly where it matters.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const sshHosts173: Migration = {
  version: 173,
  name: 'ssh_hosts',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ssh_identities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        username TEXT,
        auth_kind TEXT NOT NULL,              -- 'password' | 'privateKey' | 'agent'
        enc_password TEXT,                    -- safeStorage ciphertext (base64)
        enc_private_key TEXT,
        enc_passphrase TEXT,
        public_key TEXT,                      -- non-secret, for display
        key_type TEXT,                        -- 'ed25519' | 'rsa' | ...
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ssh_identities_project ON ssh_identities(project_id);

      CREATE TABLE IF NOT EXISTS ssh_hosts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        hostname TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        username TEXT NOT NULL,
        auth_method TEXT NOT NULL,            -- 'password' | 'privateKey' | 'agent' | 'identity'
        identity_id INTEGER REFERENCES ssh_identities(id) ON DELETE SET NULL,
        enc_password TEXT,                    -- inline secret (when not using an identity)
        enc_private_key TEXT,
        enc_passphrase TEXT,
        jump_host_id INTEGER REFERENCES ssh_hosts(id) ON DELETE SET NULL,
        group_name TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        agent_forwarding INTEGER NOT NULL DEFAULT 0,
        keepalive_secs INTEGER,
        known_host_sha256 TEXT,
        startup_snippet_id INTEGER,
        last_used_at TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ssh_hosts_project ON ssh_hosts(project_id, sort_order);

      CREATE TABLE IF NOT EXISTS ssh_snippets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ssh_snippets_project ON ssh_snippets(project_id);

      CREATE TABLE IF NOT EXISTS ssh_port_forwards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id INTEGER NOT NULL REFERENCES ssh_hosts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,                   -- 'local' | 'remote' | 'dynamic'
        bind_host TEXT,
        bind_port INTEGER NOT NULL,
        dest_host TEXT,
        dest_port INTEGER,
        auto_start INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ssh_forwards_host ON ssh_port_forwards(host_id);
    `);
  },
};
