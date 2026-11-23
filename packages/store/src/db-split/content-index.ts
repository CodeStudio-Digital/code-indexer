import type { DB } from '../db/types.js';

/** A single-column FTS5 docsize is the original token count as a big-endian varint. */
function tokenCount(size: Buffer): number {
  let count = 0;
  for (const byte of size) {
    count = count * 128 + (byte & 127);
    if (byte < 128) return count;
  }
  throw new Error('Invalid FTS5 document size');
}

/**
 * file_contents_fts stores one posting per (document, normalized term), with
 * detail=column and one column. Its original text cannot be selected. Restore
 * these postings and the original document lengths (used by BM25), including
 * empty documents, without reading potentially changed working-tree files.
 */
export function copyContentIndex(db: DB, projectId: number): void {
  const source = db.prepare("SELECT 1 FROM legacy.sqlite_schema WHERE name='file_contents_fts'").get();
  if (!source) return;
  const docs = db.prepare(`
    SELECT s.id, s.sz FROM legacy.files f
    JOIN legacy.file_contents_fts_docsize s ON s.id=f.id WHERE f.project_id=?
  `).all(projectId) as Array<{ id: number; sz: Buffer }>;
  const extra = db.prepare(`SELECT 1 FROM main.files f JOIN main.file_contents_fts_docsize d ON d.id=f.id
    LEFT JOIN legacy.file_contents_fts_docsize s ON s.id=d.id WHERE f.project_id=? AND s.id IS NULL LIMIT 1`).get(projectId);
  if (extra) throw new Error('Existing project contains additional content search documents');
  if (!docs.length) return;
  db.exec(`
    CREATE VIRTUAL TABLE temp.split_source_terms USING fts5vocab(legacy, file_contents_fts, instance);
    CREATE VIRTUAL TABLE temp.split_local_terms USING fts5vocab(main, file_contents_fts, instance);
    CREATE TEMP TABLE split_terms(doc INTEGER, term TEXT, PRIMARY KEY(doc,term)) WITHOUT ROWID;
  `);
  try {
    db.prepare(`INSERT INTO temp.split_terms
      SELECT v.doc,v.term FROM temp.split_source_terms v
      CROSS JOIN legacy.files f ON f.id=v.doc WHERE f.project_id=?`).run(projectId);
    const terms = db.prepare('SELECT term FROM temp.split_terms WHERE doc=?').pluck();
    const present = db.prepare('SELECT 1 FROM main.file_contents_fts_docsize WHERE id=?');
    const insert = db.prepare('INSERT INTO main.file_contents_fts(rowid,content) VALUES (?,?)');
    for (const { id, sz } of docs) {
      if (present.get(id)) continue;
      const words = terms.all(id) as string[];
      const padding = tokenCount(sz) - words.length;
      if (padding < 0 || (padding && !words.length)) throw new Error('Inconsistent FTS5 vocabulary');
      // Repetitions do not add postings under detail=column.
      const shortest = padding ? words.reduce((a,b) => a.length <= b.length ? a : b) : '';
      insert.run(id, words.join(' ') + (padding ? (' ' + shortest).repeat(padding) : ''));
    }
    const local = 'SELECT doc,term FROM temp.split_local_terms WHERE doc IN (SELECT id FROM main.files WHERE project_id=@pid)';
    const original = 'SELECT doc,term FROM temp.split_terms';
    const sizes = db.prepare(`SELECT 1 FROM legacy.file_contents_fts_docsize s
      JOIN legacy.files f ON f.id=s.id LEFT JOIN main.file_contents_fts_docsize d ON d.id=s.id
      WHERE f.project_id=? AND s.sz IS NOT d.sz LIMIT 1`).get(projectId);
    if (sizes || db.prepare(original + ' EXCEPT ' + local + ' LIMIT 1').get({ pid: projectId })
      || db.prepare(local + ' EXCEPT ' + original + ' LIMIT 1').get({ pid: projectId })) {
      throw new Error('Content search index differs from the source');
    }
  } finally {
    db.exec('DROP TABLE temp.split_source_terms; DROP TABLE temp.split_local_terms; DROP TABLE temp.split_terms');
  }
}
