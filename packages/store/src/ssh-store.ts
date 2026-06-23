/**
 * SshStore — CRUD for the embedded SSH client tables (migration 173):
 * saved hosts + reusable identities (snippets/forwards land in their phases).
 * Project-scoped. Dual-mode constructor (path | shared DB handle), same as
 * ApiClientStore.
 *
 * The store is intentionally Electron-free and crypto-free: `enc_*` columns are
 * persisted verbatim as opaque base64 ciphertext (the renderer encrypts via the
 * OS keychain before writing). This keeps the store unit-testable under
 * node:sqlite without the Electron ABI.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type {
  SshHost,
  SshIdentity,
  SshSnippet,
  CreateSshHostInput,
  CreateSshIdentityInput,
  CreateSshSnippetInput,
  SshHostPatch,
  SshIdentityPatch,
  SshSnippetPatch,
} from './ssh-store-types.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;
type Row = Record<string, unknown>;

export class SshStore {
  private db: DB;

  constructor(dbOrPath: DB | string) {
    this.db = typeof dbOrPath === 'string' ? new Database(dbOrPath) : dbOrPath;
  }

  // ─── Hosts ───────────────────────────────────────────────────────────
  listHosts(projectId: number): SshHost[] {
    return this.db
      .prepare('SELECT * FROM ssh_hosts WHERE project_id = ? ORDER BY sort_order, label')
      .all(projectId) as SshHost[];
  }

  getHost(id: number): SshHost | null {
    return (this.db.prepare('SELECT * FROM ssh_hosts WHERE id = ?').get(id) as SshHost | undefined) ?? null;
  }

  createHost(input: CreateSshHostInput): SshHost {
    const info = this.db
      .prepare(
        `INSERT INTO ssh_hosts
           (project_id, label, hostname, port, username, auth_method, identity_id,
            enc_password, enc_private_key, enc_passphrase, jump_host_id, group_name,
            tags_json, agent_forwarding, keepalive_secs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.project_id,
        input.label,
        input.hostname,
        input.port ?? 22,
        input.username,
        input.auth_method,
        input.identity_id ?? null,
        input.enc_password ?? null,
        input.enc_private_key ?? null,
        input.enc_passphrase ?? null,
        input.jump_host_id ?? null,
        input.group_name ?? null,
        JSON.stringify(input.tags ?? []),
        input.agent_forwarding ? 1 : 0,
        input.keepalive_secs ?? null,
      );
    return this.getHost(Number(info.lastInsertRowid))!;
  }

  updateHost(id: number, patch: SshHostPatch): void {
    const cols: Record<string, unknown> = { ...patch };
    if ('tags' in cols) {
      cols.tags_json = JSON.stringify((cols.tags as string[] | undefined) ?? []);
      delete cols.tags;
    }
    if ('agent_forwarding' in cols) cols.agent_forwarding = cols.agent_forwarding ? 1 : 0;
    this.applyPatch('ssh_hosts', id, cols);
  }

  deleteHost(id: number): void {
    this.db.prepare('DELETE FROM ssh_port_forwards WHERE host_id = ?').run(id);
    this.db.prepare('DELETE FROM ssh_hosts WHERE id = ?').run(id);
  }

  touchHostUsed(id: number): void {
    this.db.prepare(`UPDATE ssh_hosts SET last_used_at = datetime('now') WHERE id = ?`).run(id);
  }

  // ─── Identities ──────────────────────────────────────────────────────
  listIdentities(projectId: number): SshIdentity[] {
    return this.db
      .prepare('SELECT * FROM ssh_identities WHERE project_id = ? ORDER BY name')
      .all(projectId) as SshIdentity[];
  }

  getIdentity(id: number): SshIdentity | null {
    return (this.db.prepare('SELECT * FROM ssh_identities WHERE id = ?').get(id) as SshIdentity | undefined) ?? null;
  }

  createIdentity(input: CreateSshIdentityInput): SshIdentity {
    const info = this.db
      .prepare(
        `INSERT INTO ssh_identities
           (project_id, name, username, auth_kind, enc_password, enc_private_key,
            enc_passphrase, public_key, key_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.project_id,
        input.name,
        input.username ?? null,
        input.auth_kind,
        input.enc_password ?? null,
        input.enc_private_key ?? null,
        input.enc_passphrase ?? null,
        input.public_key ?? null,
        input.key_type ?? null,
      );
    return this.getIdentity(Number(info.lastInsertRowid))!;
  }

  updateIdentity(id: number, patch: SshIdentityPatch): void {
    this.applyPatch('ssh_identities', id, { ...patch });
  }

  deleteIdentity(id: number): void {
    this.db.prepare('DELETE FROM ssh_identities WHERE id = ?').run(id);
  }

  // ─── Snippets ────────────────────────────────────────────────────────
  listSnippets(projectId: number): SshSnippet[] {
    return this.db
      .prepare('SELECT * FROM ssh_snippets WHERE project_id = ? ORDER BY name')
      .all(projectId) as SshSnippet[];
  }

  getSnippet(id: number): SshSnippet | null {
    return (this.db.prepare('SELECT * FROM ssh_snippets WHERE id = ?').get(id) as SshSnippet | undefined) ?? null;
  }

  createSnippet(input: CreateSshSnippetInput): SshSnippet {
    const info = this.db
      .prepare('INSERT INTO ssh_snippets (project_id, name, command) VALUES (?, ?, ?)')
      .run(input.project_id, input.name, input.command);
    return this.getSnippet(Number(info.lastInsertRowid))!;
  }

  updateSnippet(id: number, patch: SshSnippetPatch): void {
    this.applyPatch('ssh_snippets', id, { ...patch });
  }

  deleteSnippet(id: number): void {
    this.db.prepare('DELETE FROM ssh_snippets WHERE id = ?').run(id);
  }

  /**
   * Build + run an UPDATE from a partial column map, always bumping updated_at.
   *
   * SECURITY: column NAMES are interpolated into SQL (only values are bound), and
   * the `cols` map originates from an HTTP PATCH body. Each key is validated
   * against a per-table allow-list of writable columns BEFORE building the SET
   * clause — an unknown key (e.g. a smuggled SQL fragment like
   * `project_id = 999, label`) throws rather than reaching the query. This blocks
   * column-name SQL injection + cross-project re-parenting.
   */
  private applyPatch(table: string, id: number, cols: Record<string, unknown>): void {
    const keys = Object.keys(cols).filter((k) => cols[k] !== undefined);
    if (keys.length === 0) return;
    const allow = WRITABLE_COLUMNS[table];
    for (const k of keys) {
      if (!allow || !allow.has(k)) throw new Error(`ssh-store: column not writable in ${table}: ${k}`);
    }
    const set = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => normalizeValue(cols[k] as Row[string]));
    this.db
      .prepare(`UPDATE ${table} SET ${set}, updated_at = datetime('now') WHERE id = ?`)
      .run(...values, id);
  }
}

/** Per-table allow-list of caller-writable columns (never `id`/`project_id`/`created_at`). */
const WRITABLE_COLUMNS: Record<string, ReadonlySet<string>> = {
  ssh_hosts: new Set([
    'label', 'hostname', 'port', 'username', 'auth_method', 'identity_id',
    'enc_password', 'enc_private_key', 'enc_passphrase', 'jump_host_id', 'group_name',
    'tags_json', 'agent_forwarding', 'keepalive_secs', 'known_host_sha256', 'startup_snippet_id',
    'last_used_at', 'sort_order',
  ]),
  ssh_identities: new Set([
    'name', 'username', 'auth_kind', 'enc_password', 'enc_private_key', 'enc_passphrase', 'public_key', 'key_type',
  ]),
  ssh_snippets: new Set(['name', 'command']),
};

/** SQLite can't bind booleans/objects — coerce to its supported primitives. */
function normalizeValue(v: unknown): unknown {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v ?? null;
}
