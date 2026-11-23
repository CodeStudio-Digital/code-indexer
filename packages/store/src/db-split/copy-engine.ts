import type { DB } from '../db/types.js';
import { copyContentIndex } from './content-index.js';
import { manifestFor, entryWhere, type SplitClass } from './manifest.js';

export interface CopyResult {
  perTable: Record<string, number>;
  total: number;
}

function columns(db: DB, schema: 'main' | 'legacy', table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info("${table}")`).all() as { name: string }[]).map(c => c.name);
}

function copyProjectLineage(db: DB, projectId: number): void {
  const source = columns(db, 'legacy', 'projects');
  const common = columns(db, 'main', 'projects').filter(c => source.includes(c));
  const list = common.map(c => `"${c}"`).join(',');
  const parent = common.includes('worktree_parent_id');
  const ancestors = parent ? `UNION SELECT p.worktree_parent_id FROM legacy.projects p
    JOIN lineage l ON p.id=l.id WHERE p.worktree_parent_id IS NOT NULL` : '';
  // Only catalog metadata travels up the chain. Index rows still use the child id.
  const lineage = `WITH RECURSIVE lineage(id) AS (SELECT @pid ${ancestors})`;
  db.prepare(`${lineage} INSERT INTO main.projects (${list})
    SELECT ${list} FROM legacy.projects WHERE id IN (SELECT id FROM lineage)
    ON CONFLICT(id) DO NOTHING`).run({ pid: projectId });
  const conflict = db.prepare(`${lineage} SELECT 1 FROM lineage l
    JOIN legacy.projects s ON s.id=l.id LEFT JOIN main.projects d ON d.id=l.id
    WHERE d.id IS NULL OR s.name IS NOT d.name OR s.root_path IS NOT d.root_path
    ${parent ? 'OR s.worktree_parent_id IS NOT d.worktree_parent_id' : ''} LIMIT 1`).get({pid: projectId});
  if (conflict) throw new Error('Project identity or worktree lineage conflicts with the existing index');
}

/** Import in a single transaction. A retry reuses matching rows and rejects divergent values. */
export function copyProjectData(
  proj: DB, legacyCentralPath: string, projectId: number, classes: SplitClass[] = ['INDEX'],
  beforeCommit?: () => void,
): CopyResult {
  const perTable: Record<string, number> = {};
  let total = 0;
  const fk = proj.pragma('foreign_keys', { simple: true });
  proj.prepare('ATTACH DATABASE ? AS legacy').run(legacyCentralPath);
  try {
    proj.pragma('foreign_keys = OFF');
    proj.transaction(() => {
      copyProjectLineage(proj, projectId);
      for (const entry of manifestFor(classes)) {
        const src = columns(proj, 'legacy', entry.table);
        if (!src.length) continue;
        const dest = columns(proj, 'main', entry.table);
        if (src.some(c => !dest.includes(c))) throw new Error(`Incomplete target schema for ${entry.table}`);
        const list = src.map(c => `"${c}"`).join(',');
        const where = entryWhere(entry);
        const originals = `SELECT ${list} FROM legacy."${entry.table}" WHERE ${where}`;
        const local = `SELECT ${list} FROM main."${entry.table}" WHERE ${where.replaceAll('legacy.', 'main.')}`;
        const params = { pid: projectId };
        const inserted = proj.prepare(`INSERT INTO main."${entry.table}" (${list})
          ${originals} ON CONFLICT DO NOTHING`).run(params);
        // The ids, blobs and values must match in both directions, including child tables.
        if (proj.prepare(originals + ' EXCEPT ' + local + ' LIMIT 1').get(params)
          || proj.prepare(local + ' EXCEPT ' + originals + ' LIMIT 1').get(params)) {
          throw new Error(`Row values differ for ${entry.table}; existing project data preserved`);
        }
        perTable[entry.table] = inserted.changes;
        total += inserted.changes;
      }
      if (classes.includes('INDEX')) copyContentIndex(proj, projectId);
      const violations = proj.pragma('main.foreign_key_check') as { table: string; parent: string }[];
      if (violations.length) throw new Error(`Foreign key violation in ${violations[0].table} → ${violations[0].parent}`);
      beforeCommit?.();
    })();
  } finally {
    try { proj.exec('DETACH DATABASE legacy'); }
    finally { if (fk) proj.pragma('foreign_keys = ON'); }
  }
  return { perTable, total };
}
