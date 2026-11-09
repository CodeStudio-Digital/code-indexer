import type { DB } from './types.js';

export interface StructuralDelta { path: string; kind: 'upsert' | 'delete'; version: number }

/** Control-plane state in the central DB, independent of index routing. */
export function structuralJournal(db: DB) {
  return {
    load: (id: number) => db.prepare('SELECT path, kind, version FROM structural_dirty WHERE project_id = ? ORDER BY version').all(id) as StructuralDelta[],
    put: (id: number, entries: StructuralDelta[]) => db.transaction(() => {
      const put = db.prepare(`INSERT INTO structural_dirty(project_id,path,kind,version) VALUES (?,?,?,?)
        ON CONFLICT(project_id,path) DO UPDATE SET kind=excluded.kind,version=excluded.version`);
      for (const e of entries) put.run(id, e.path, e.kind, e.version);
    })(),
    ack: (id: number, entries: StructuralDelta[]) => db.transaction(() => {
      const ack = db.prepare('DELETE FROM structural_dirty WHERE project_id=? AND path=? AND version=?');
      for (const e of entries) ack.run(id, e.path, e.version);
    })(),
    clear: (id: number) => { db.prepare('DELETE FROM structural_dirty WHERE project_id=?').run(id); },
  };
}

export function readStructuralRevision(db: DB, projectId: number): string {
  const row = db.prepare('SELECT generation, revision FROM structural_revisions WHERE project_id=?').get(projectId) as
    { generation: string; revision: number } | undefined;
  return row ? `${row.generation}:${row.revision}` : 'empty';
}

export function bumpContentRevision(db: DB, fileId: number): void {
  db.prepare(`INSERT INTO structural_revisions(project_id,revision)
    SELECT project_id,1 FROM files WHERE id=?
    ON CONFLICT(project_id) DO UPDATE SET revision=revision+1`).run(fileId);
}
