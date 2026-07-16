import type { DB } from '../types.js';

export function rebuildSnapshotsFtsIfEmpty(db: DB): void {
  try {
    const count = (db.prepare('SELECT COUNT(*) as c FROM snapshots_fts').get() as { c: number }).c;
    if (count === 0) {
      const snapCount = (db.prepare('SELECT COUNT(*) as c FROM snapshots').get() as { c: number }).c;
      if (snapCount > 0) {
        db.exec(`INSERT INTO snapshots_fts(rowid, title, content, tags) SELECT id, title, content, tags FROM snapshots`);
      }
    }
  } catch { /* ignore */ }
}
