import type { Migration } from './types.js';

export const symbolFileLookup281: Migration = {
  version: 281,
  name: 'symbol_file_lookup',
  runsOnTrimmedProject: true,
  up(db) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_project_file_line ON symbols(project_id, file_path, line)');
  },
};
