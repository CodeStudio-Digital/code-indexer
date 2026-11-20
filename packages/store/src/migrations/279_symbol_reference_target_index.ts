import type { Migration } from './types.js';

export const symbolReferenceTargetIndex279: Migration = {
  version: 279,
  name: 'symbol_reference_target_index',
  runsOnTrimmedProject: true,
  up(db) {
    // Replacing a file's symbols invokes ON DELETE SET NULL on this key.
    db.exec('CREATE INDEX IF NOT EXISTS idx_symbol_refs_symbol_id ON symbol_references(symbol_id)');
  },
};
