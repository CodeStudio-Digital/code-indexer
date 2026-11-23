import { structuralState271 } from './271-structural-state.js';
import type { Migration } from './types.js';

export const legacyFileFlags287: Migration = {
  version: 287,
  name: 'legacy_file_classification_flags',
  runsOnTrimmedProject: true,
  up(db) {
    const columns = db.prepare('SELECT name FROM pragma_table_info(?)').pluck().all('files');
    const missing = ['is_entry_point', 'is_test', 'is_generated'].filter(name => !columns.includes(name));
    if (!missing.length) return;
    for (const column of missing) db.exec(`ALTER TABLE files ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    db.exec('DROP TRIGGER IF EXISTS structural_revision_files_update');
    structuralState271.up(db);
  },
};
