/**
 * Migration 156 — Postman-parity overhaul of api_requests.
 *
 * Adds the columns the richer request editor needs, in one batch:
 *   - Body: raw-language hint + per-kind payload columns (form-data, urlencoded,
 *     graphql, binary) so switching body kind never destroys another kind's content.
 *   - Scripts: pre-request + test (post-response) JS source (Postman `pm.*`).
 *   - Auth: type + per-type config JSON (bearer/basic/apikey/oauth2).
 *
 * headers_json/query_json are NOT touched here — they keep their TEXT column and
 * merely change interpretation (legacy `{k:v}` object OR new KvRow[] array; both
 * are accepted by request-builder's normalizeKvList).
 *
 * ADD COLUMN is not idempotent at the SQL level (no IF NOT EXISTS), so each add
 * is guarded by a PRAGMA table_info check — re-running is a no-op.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

interface ColumnSpec {
  name: string;
  decl: string;
}

const COLUMNS: ColumnSpec[] = [
  { name: 'body_raw_lang', decl: 'body_raw_lang TEXT' },
  { name: 'body_form_json', decl: "body_form_json TEXT DEFAULT '[]'" },
  { name: 'body_urlencoded_json', decl: "body_urlencoded_json TEXT DEFAULT '[]'" },
  { name: 'body_graphql_json', decl: 'body_graphql_json TEXT' },
  { name: 'body_binary_path', decl: 'body_binary_path TEXT' },
  { name: 'pre_request_script', decl: 'pre_request_script TEXT' },
  { name: 'test_script', decl: 'test_script TEXT' },
  { name: 'auth_type', decl: 'auth_type TEXT' },
  { name: 'auth_json', decl: 'auth_json TEXT' },
];

export const apiRequestPostmanOverhaul156: Migration = {
  version: 156,
  name: 'api_request_postman_overhaul',
  up: (db: DB): void => {
    const existing = new Set(
      (db.prepare('PRAGMA table_info(api_requests)').all() as { name: string }[]).map((c) => c.name),
    );
    for (const col of COLUMNS) {
      if (existing.has(col.name)) continue;
      db.exec(`ALTER TABLE api_requests ADD COLUMN ${col.decl};`);
    }
  },
};
