/**
 * 064 — Attached external containers.
 *
 * Adds three columns to `company_sandbox_services` so a service row can
 * reference an existing Podman/Docker container that the platform did
 * NOT create and must NOT control. The user supplies the container
 * id/name; the only operation we ever perform on it is `inspect`. Start,
 * stop, pause, restart and remove are bypassed for these rows.
 *
 *   is_attached            — discriminator (0 = managed, 1 = attached)
 *   external_container_ref — user-supplied id or name (e.g. "extpg")
 *   attached_hostname      — DNS name reachable from peer containers
 *                            on the shared session network. Defaults to
 *                            the service_id when not specified.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

function hasColumn(db: DB, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

export const attachedServices064 = {
  version: 64,
  name: 'attached_services',
  up(db: DB) {
    addColumnIfMissing(
      db,
      'company_sandbox_services',
      'is_attached',
      'is_attached INTEGER NOT NULL DEFAULT 0 CHECK(is_attached IN (0,1))',
    );
    addColumnIfMissing(
      db,
      'company_sandbox_services',
      'external_container_ref',
      'external_container_ref TEXT',
    );
    addColumnIfMissing(
      db,
      'company_sandbox_services',
      'attached_hostname',
      'attached_hostname TEXT',
    );
  },
};
