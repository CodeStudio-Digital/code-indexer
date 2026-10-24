/**
 * Migration 140 — `file_contents_fts`, the raw-content word index
 * (IntelliJ-style) behind instant grep pre-filtering and content-aware FTS
 * search on structurally-indexed projects.
 *
 * Contentless (content=''): file contents live on disk, only the inverted
 * index is stored (~0.2-0.4x of source size with detail=column vs ~1.5-3x
 * for trigram). `contentless_delete=1` (SQLite ≥ 3.43; bundled 3.49.2)
 * enables `DELETE ... WHERE rowid=?` so the AFTER-DELETE trigger on `files`
 * keeps it in sync. Rows are written by the index pipeline (content is not
 * stored in any base table, so insert/update CANNOT be trigger-driven).
 *
 * NOTE: contentless tables do NOT support `INSERT INTO t(t) VALUES('rebuild')`
 * — corruption recovery recreates the table empty and the structural run's
 * coverage sweep repopulates it (see repairFileContentsFts / sweep).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';
import { createFileContentsFts } from '../db/schema/content-fts.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const fileContentsFts140: Migration = {
  version: 140,
  name: 'file_contents_fts',
  up: (db: DB): void => {
    createFileContentsFts(db);
  },
};
