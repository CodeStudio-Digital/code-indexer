/**
 * Migration 037 — persist `host_workdir_mount` per service.
 *
 * Why: after an image rebuild (or any event that wipes containers) the
 * reconcile path needs to RE-provision each service with the same
 * bind-mount it had originally — otherwise agents lose the workdir
 * the old container saw, and the UI silently drops the service.
 * The primary sandbox already has this info; services didn't.
 *
 * The column is nullable because legacy rows (pre-037) don't have it;
 * reconcile falls back to the per-session default layout when null.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const serviceHostWorkdir037 = {
  version: 37,
  name: 'service_host_workdir',
  up(db: DB) {
    db.exec(`
      ALTER TABLE company_sandbox_services
        ADD COLUMN host_workdir_mount TEXT;
    `);
  },
};
