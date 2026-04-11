import type DatabaseConstructor from 'better-sqlite3';
type DB = InstanceType<typeof DatabaseConstructor>;

/**
 * Migration 021: Add structure_embedding column to files table.
 *
 * This allows caching the embedded vector of the file's structure signature.
 * When the structure_hash changes but the cosine similarity between the old
 * and new structure_embedding is >= 0.98, we can reuse the generative analysis
 * (summary and concepts) safely instead of calling the LLM again.
 */
export const structureEmbedding021 = {
  version: 21,
  name: 'structure_embedding',
  up(db: DB) {
    const cols = db.pragma('table_info(files)') as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'structure_embedding')) {
      // BLOB for storing Float32Array bytes
      db.exec('ALTER TABLE files ADD COLUMN structure_embedding BLOB');
    }
  },
};
