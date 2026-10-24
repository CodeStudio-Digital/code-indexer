import type { DB } from '../types.js';
import { createBaseTables } from './tables.js';
import { createFtsTables, createDocChunksFtsIfReady } from './fts.js';
import { rebuildSnapshotsFtsIfEmpty } from './bootstrap.js';

export function initSchema(db: DB): void {
  // A fresh project used to commit every DDL statement separately. Keep the
  // baseline atomic and pay one durable commit; migrations retain their own
  // transactions and PRAGMA handling outside this bootstrap.
  db.transaction(() => {
    createBaseTables(db);
    createFtsTables(db);
    createDocChunksFtsIfReady(db);
    rebuildSnapshotsFtsIfEmpty(db);
  })();
}
