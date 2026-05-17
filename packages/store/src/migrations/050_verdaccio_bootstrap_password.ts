/**
 * Migration 050 — Verdaccio bootstrap password.
 *
 * Adds a `bootstrap_password` column to `verdaccio_configs` so the
 * VerdaccioService can REUSE the same password across `enable()`
 * cycles. Previously each cycle generated a fresh random password,
 * which created a 401 deadlock when the persisted storage already had
 * a `dsadmin` entry from a previous bootstrap (htpasswd matched the
 * username but not the new password) — the registry then rejected
 * `PUT /-/user` with "unauthorized access" instead of treating it as
 * a login. Persisting the password lets the same PUT serve as either
 * "create user" (fresh storage) or "login" (existing user) and always
 * return a fresh session token.
 *
 * Stored as plaintext: the password is throwaway (only ever consumed
 * by Verdaccio's CouchDB-style PUT endpoint, never by humans), the
 * registry runs on loopback (127.0.0.1) inside the operator's host,
 * and the token derived from this password is what actually flows
 * through `npm publish`. Encryption-at-rest would protect against an
 * attacker who already has read access to `index.db`, at which point
 * the token in the same row already gives them everything anyway.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const verdaccioBootstrapPassword050 = {
  version: 50,
  name: 'verdaccio_bootstrap_password',
  up(db: DB) {
    db.exec(`
      ALTER TABLE verdaccio_configs
        ADD COLUMN bootstrap_password TEXT;
    `);
  },
};
