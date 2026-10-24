import type { Migration } from './types.js';

/** Preserve old rows as unknown; deriving call/import semantics from snippets
 * would invent evidence. Structural reindexing fills the classification. */
export const symbolReferenceKind269: Migration = {
  version: 269,
  name: 'symbol_reference_kind',
  up(db) {
    const columns = db.prepare('PRAGMA table_info(symbol_references)').all() as Array<{ name: string }>;
    if (!columns.some(c => c.name === 'reference_kind')) db.exec('ALTER TABLE symbol_references ADD COLUMN reference_kind TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_symbol_refs_project_name_kind ON symbol_references(project_id,symbol_name,reference_kind,referencing_file_path,line)');
  },
};
