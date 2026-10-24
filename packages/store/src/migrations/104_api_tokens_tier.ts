/**
 * Migration 104 — add `tier` column to `api_tokens`.
 *
 * The HTTP MCP endpoint already accepts any token whose scopes include
 * `mcp:write` (or `mcp:read` for resources). That works as a coarse
 * RBAC, but it gives every authenticated client access to the *full*
 * ~150-tool catalog — including write/git/admin tools the operator may
 * not want exposed.
 *
 * `tier` mirrors the agent's tool-tier system (bootstrap/navigate/admin
 * defined in `packages/code-agent/src/tools/tiers.ts`). When set, the
 * MCP HTTP transport filters `tools/list` and gates `tools/call` so the
 * token only sees / can run tools ≤ its tier:
 *
 *   bootstrap  → ~30 read/search tools (incl. rag_search_docs)
 *   navigate   → bootstrap + write/edit/run/git read tools
 *   admin      → everything
 *
 * `tier = NULL` preserves the old behaviour (scope-only check) so we
 * don't break existing tokens.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const apiTokensTier104: Migration = {
  version: 104,
  name: 'api_tokens_tier',
  up: (db: DB): void => {
    // SQLite ALTER TABLE ADD COLUMN with a NULL default is cheap and
    // backward-compatible — existing rows keep tier=NULL and behave
    // exactly as before.
    db.exec(`ALTER TABLE api_tokens ADD COLUMN tier TEXT`);
  },
};
