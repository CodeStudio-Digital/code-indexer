import type { DB } from '../types.js';
import { createBaseTables } from './tables.js';
import { createFtsTables, createDocChunksFtsIfReady } from './fts.js';
import { rebuildSnapshotsFtsIfEmpty } from './bootstrap.js';

export function initSchema(db: DB): void {
  createBaseTables(db);
  createFtsTables(db);
  createDocChunksFtsIfReady(db);
  rebuildSnapshotsFtsIfEmpty(db);
}
