import type { Migration } from './types.js';

export const fileContentFtsExclusion280: Migration = {
  version: 280,
  name: 'file_content_fts_exclusion',
  runsOnTrimmedProject: true,
  up(db) {
    const columns = db.prepare('PRAGMA table_info(files)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'content_fts_exclusion')) {
      db.exec('ALTER TABLE files ADD COLUMN content_fts_exclusion TEXT');
    }
  },
};
