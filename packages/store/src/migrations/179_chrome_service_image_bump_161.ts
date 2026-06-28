/**
 * Migration 179 — Upgrade the persisted Chrome Service image from
 * v1.60.0 to v1.61.1 (to match the bumped `playwright-core` client +
 * `PINNED_PLAYWRIGHT_TEST_VERSION`).
 *
 * Same rationale as migration 100: enable/restart cycles read the image
 * FROM THE DB, so bumping `DEFAULT_CHROME_SERVICE_IMAGE` in
 * `host-alias.ts` only affects the column DEFAULT for brand-new schemas.
 * Operators who enabled Chrome Service before this bump keep starting the
 * old 1.60.0 container, and `connectBrowser` then fails with the "Looks
 * like Playwright was just updated to 1.61.1" banner because the npm
 * client (playwright-core / @playwright/test) is already 1.61.1.
 *
 * Strategy: UPDATE ... WHERE image IN (known-old-defaults). After
 * migration 100, every out-of-the-box row holds the 1.60.0 tag — that is
 * the only value we auto-upgrade. Operators who customised the image
 * (custom registry mirror, pinned variant) are NOT touched.
 *
 * If a future bump is needed, add the new old default to
 * `KNOWN_OLD_IMAGES` and another migration that points at the new tag —
 * re-running on a post-bump row is a no-op (the WHERE clause won't match).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

/**
 * Images we're willing to auto-upgrade. Keep this list narrow — anything
 * we don't recognize is treated as a deliberate operator override and
 * left alone.
 */
const KNOWN_OLD_IMAGES: readonly string[] = ['mcr.microsoft.com/playwright:v1.60.0-jammy'];

const NEW_IMAGE = 'mcr.microsoft.com/playwright:v1.61.1-jammy';

export const chromeServiceImageBump161_179: Migration = {
  version: 179,
  name: 'chrome_service_image_bump_161',
  up: (db: DB): void => {
    // `chrome_service_configs` is a CENTRAL-only table. Per-project index DBs
    // run the SAME migration lineage (see project-schema.ts) but never carry
    // this table, so a bare UPDATE throws "no such table" and aborts the whole
    // project-DB init — which crashes runCoder before it persists the first
    // message. No config table = nothing to bump → skip silently.
    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chrome_service_configs'")
      .get();
    if (!tbl) return;
    const placeholders = KNOWN_OLD_IMAGES.map(() => '?').join(',');
    const stmt = db.prepare(
      `UPDATE chrome_service_configs
          SET image      = ?,
              updated_at = datetime('now')
        WHERE id = 1
          AND image IN (${placeholders})`,
    );
    stmt.run(NEW_IMAGE, ...KNOWN_OLD_IMAGES);
  },
};
