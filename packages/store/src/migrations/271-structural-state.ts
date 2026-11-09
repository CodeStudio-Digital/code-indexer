import type { Migration } from './types.js';

export const structuralState271: Migration = {
  version: 271,
  name: 'structural_delta_journal_and_revision',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS structural_dirty (
      project_id INTEGER NOT NULL, path TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('upsert','delete')), version INTEGER NOT NULL,
      PRIMARY KEY(project_id,path));
      CREATE TABLE IF NOT EXISTS structural_revisions (
      project_id INTEGER PRIMARY KEY, generation TEXT NOT NULL DEFAULT (hex(randomblob(16))),
      revision INTEGER NOT NULL DEFAULT 0);`);
    for (const table of ['files', 'symbols', 'symbol_references', 'symbol_relations', 'file_dependencies']) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === 'project_id')) continue;
      for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
        const ref = op === 'DELETE' ? 'OLD' : 'NEW';
        const meaningful = cols.filter((c) => !['mtime_ms', 'updated_at', 'created_at'].includes(c.name));
        const when = op === 'UPDATE' ? `WHEN ${meaningful.map((c) => `OLD."${c.name}" IS NOT NEW."${c.name}"`).join(' OR ')}` : '';
        db.exec(`CREATE TRIGGER IF NOT EXISTS structural_revision_${table}_${op.toLowerCase()}
          AFTER ${op} ON ${table} ${when} BEGIN
          INSERT INTO structural_revisions(project_id,revision) VALUES (${ref}.project_id,1)
          ON CONFLICT(project_id) DO UPDATE SET revision=revision+1;
          END;`);
      }
    }
  },
};
