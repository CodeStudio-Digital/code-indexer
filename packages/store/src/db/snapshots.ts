import type { ContextSnapshot, SnapshotCategory, SnapshotVersion } from '@mcp/shared/types.js';
import type { DB } from './types.js';

export interface CreateSnapshotData {
  title: string;
  category: SnapshotCategory;
  content: string;
  tags?: string[];
  createdBy?: string;
  /** Memory provenance (migration 114). Defaults to 'manual'. */
  source?: string;
  /** 0..1 salience (migration 114). Defaults to 0.5. */
  importance?: number;
}

export type UpdateSnapshotData = Partial<Pick<ContextSnapshot, 'title' | 'category' | 'content'>> & {
  tags?: string[];
  updatedBy?: string;
};

export function create(db: DB, projectId: number, data: CreateSnapshotData): ContextSnapshot {
  const result = db.prepare(`
    INSERT INTO snapshots (project_id, title, category, content, tags, created_by, source, importance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId, data.title, data.category, data.content,
    JSON.stringify(data.tags ?? []), data.createdBy ?? 'manual',
    data.source ?? 'manual', data.importance ?? 0.5
  );
  return db.prepare('SELECT * FROM snapshots WHERE id = ?')
    .get(result.lastInsertRowid) as ContextSnapshot;
}

/** Bump usage signal when memory is retrieved (migration 114). Best-effort. */
export function markAccessed(db: DB, ids: number[]): void {
  if (ids.length === 0) return;
  const stmt = db.prepare(
    `UPDATE snapshots SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?`,
  );
  const tx = db.transaction((list: number[]) => {
    for (const id of list) stmt.run(id);
  });
  tx(ids);
}

export function setFiles(db: DB, snapshotId: number, projectId: number, filePaths: string[]): { inserted: number; skipped: string[] } {
  let inserted = 0;
  const skipped: string[] = [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM snapshot_files WHERE snapshot_id = ?').run(snapshotId);
    if (filePaths.length === 0) return;
    const getHash = db.prepare('SELECT content_hash FROM files WHERE project_id = ? AND path = ?');
    const insert = db.prepare(
      'INSERT OR REPLACE INTO snapshot_files (snapshot_id, file_path, file_hash_at_creation) VALUES (?, ?, ?)'
    );
    for (const p of filePaths) {
      const row = getHash.get(projectId, p) as { content_hash: string } | undefined;
      if (row) {
        insert.run(snapshotId, p, row.content_hash);
        inserted++;
      } else {
        skipped.push(p);
      }
    }
  });
  tx();
  return { inserted, skipped };
}

export function getStaleFiles(db: DB, snapshotId: number, projectId: number): string[] {
  const rows = db.prepare(`
    SELECT sf.file_path, sf.file_hash_at_creation, f.content_hash
    FROM snapshot_files sf
    LEFT JOIN files f ON f.project_id = ? AND f.path = sf.file_path
    WHERE sf.snapshot_id = ?
  `).all(projectId, snapshotId) as {
    file_path: string;
    file_hash_at_creation: string;
    content_hash: string | null;
  }[];
  const stale: string[] = [];
  for (const r of rows) {
    if (r.content_hash === null || r.content_hash !== r.file_hash_at_creation) {
      stale.push(r.file_path);
    }
  }
  return stale;
}

export function getFiles(db: DB, snapshotId: number): string[] {
  const rows = db.prepare(
    'SELECT file_path FROM snapshot_files WHERE snapshot_id = ? ORDER BY file_path'
  ).all(snapshotId) as { file_path: string }[];
  return rows.map((r) => r.file_path);
}

export function update(db: DB, id: number, updates: UpdateSnapshotData): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
  if (updates.category !== undefined) { fields.push('category = ?'); values.push(updates.category); }
  if (updates.content !== undefined) { fields.push('content = ?'); values.push(updates.content); }
  if (updates.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(updates.tags)); }

  if (fields.length === 0) return;

  fields.push("updated_at = datetime('now')");
  if (updates.title !== undefined || updates.content !== undefined) {
    fields.push('embedding_hash = NULL');
  }
  values.push(id);

  const updatedBy = updates.updatedBy ?? 'manual';

  const tx = db.transaction(() => {
    const current = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as ContextSnapshot | undefined;
    if (current) {
      const maxVersion = db.prepare(
        'SELECT COALESCE(MAX(version), 0) as v FROM snapshot_versions WHERE snapshot_id = ?'
      ).get(id) as { v: number };

      db.prepare(`
        INSERT INTO snapshot_versions (snapshot_id, version, title, category, content, tags, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, maxVersion.v + 1, current.title, current.category, current.content, current.tags, current.updated_at, updatedBy);

      db.prepare(
        "INSERT INTO snapshots_fts(snapshots_fts, rowid, title, content, tags) VALUES ('delete', ?, ?, ?, ?)"
      ).run(current.id, current.title, current.content, current.tags);
    }

    db.prepare(`UPDATE snapshots SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as ContextSnapshot | undefined;
    if (updated) {
      db.prepare(
        'INSERT INTO snapshots_fts(rowid, title, content, tags) VALUES (?, ?, ?, ?)'
      ).run(updated.id, updated.title, updated.content, updated.tags);
    }
  });

  tx();
}

export function updateEmbeddingHash(db: DB, id: number, hash: string): void {
  db.prepare('UPDATE snapshots SET embedding_hash = ? WHERE id = ?').run(hash, id);
}

export function listMissingEmbedding(db: DB, projectId?: number): ContextSnapshot[] {
  if (projectId === undefined) {
    return db.prepare('SELECT * FROM snapshots WHERE embedding_hash IS NULL ORDER BY id').all() as ContextSnapshot[];
  }
  return db.prepare('SELECT * FROM snapshots WHERE project_id = ? AND embedding_hash IS NULL ORDER BY id')
    .all(projectId) as ContextSnapshot[];
}

export function count(db: DB, projectId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM snapshots WHERE project_id = ?')
    .get(projectId) as { c: number };
  return row.c;
}

export function countVectors(db: DB, projectId: number): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM vector_ids WHERE project_id = ? AND type = 'snapshot'")
    .get(projectId) as { c: number };
  return row.c;
}

export function del(db: DB, id: number): void {
  db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
}

export function getById(db: DB, id: number): ContextSnapshot | undefined {
  return db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as ContextSnapshot | undefined;
}

export function list(db: DB, projectId: number, category?: SnapshotCategory): ContextSnapshot[] {
  if (category) {
    return db.prepare('SELECT * FROM snapshots WHERE project_id = ? AND category = ? ORDER BY created_at DESC')
      .all(projectId, category) as ContextSnapshot[];
  }
  return db.prepare('SELECT * FROM snapshots WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as ContextSnapshot[];
}

export function search(db: DB, projectId: number, query: string): ContextSnapshot[] {
  const ftsQuery = query.replace(/[-*"(){}[\]^~\\:]/g, ' ').trim().split(/\s+/).filter(Boolean).join(' OR ');
  if (!ftsQuery) return [];
  try {
    return db.prepare(`
      SELECT s.* FROM snapshots_fts fts
      JOIN snapshots s ON s.id = fts.rowid
      WHERE fts.snapshots_fts MATCH ? AND s.project_id = ?
      ORDER BY rank
    `).all(ftsQuery, projectId) as ContextSnapshot[];
  } catch {
    const pattern = `%${query}%`;
    return db.prepare(
      'SELECT * FROM snapshots WHERE project_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY created_at DESC'
    ).all(projectId, pattern, pattern) as ContextSnapshot[];
  }
}

export function getHistory(db: DB, snapshotId: number): SnapshotVersion[] {
  return db.prepare('SELECT * FROM snapshot_versions WHERE snapshot_id = ? ORDER BY version DESC')
    .all(snapshotId) as SnapshotVersion[];
}
