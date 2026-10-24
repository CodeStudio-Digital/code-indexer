/**
 * Migration 100 — Upgrade the persisted Chrome Service image from
 * the v1.59.1 default to v1.60.0 (to match the bumped `playwright-core`
 * client).
 *
 * Background: migration 045 seeded `chrome_service_configs.image` with
 * the column DEFAULT (`mcr.microsoft.com/playwright:v1.59.1-jammy`).
 * Subsequent enable/restart cycles read FROM THE DB, so bumping the
 * `DEFAULT_CHROME_SERVICE_IMAGE` constant in `host-alias.ts` only takes
 * effect on brand-new DBs. Existing operators (anyone who enabled
 * Chrome Service before the bump) keep starting the old 1.59.1
 * container, and `connectBrowser` immediately fails with the
 * "Looks like Playwright was just updated to 1.60.0" banner because
 * the npm client is already 1.60.0 (see migration's commit context).
 *
 * Strategy: UPDATE ... WHERE image IN (known-old-defaults). Operators
 * who customised the image (custom registry mirror, pinned variant)
 * are NOT touched — their hand-picked value stays put. Only rows that
 * still hold one of the documented "out-of-the-box" defaults get
 * upgraded.
 *
 * If a future bump is needed, the cheapest path is to add the new old
 * default to `KNOWN_OLD_IMAGES` here and another migration that points
 * at the new tag. No need to chain — re-running this migration on a
 * stale row is a no-op (the WHERE clause won't match the post-bump
 * value).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

/**
 * Images we're willing to auto-upgrade. Keep this list narrow — anything
 * we don't recognize is treated as a deliberate operator override and
 * left alone.
 */
const KNOWN_OLD_IMAGES: readonly string[] = [
  'mcr.microsoft.com/playwright:v1.59.1-jammy',
];

const NEW_IMAGE = 'mcr.microsoft.com/playwright:v1.60.0-jammy';

export const chromeServiceImageBump100: Migration = {
  version: 100,
  name: 'chrome_service_image_bump',
  up: (db: DB): void => {
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
