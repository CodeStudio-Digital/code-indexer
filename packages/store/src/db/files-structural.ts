import type { DB } from './types.js';

export interface UpsertStructuralData {
  /** Project-relative, forward-slash path (scanner form). */
  path: string;
  language: string;
  size: number;
  lineCount: number;
  contentHash: string;
  /**
   * Import strings from tree-sitter (same shape files.upsert stores).
   * Omitted (language unsupported) → existing values are preserved on
   * UPDATE; INSERT defaults to empty.
   */
  dependencies?: string[];
  internalDeps?: string[];
  externalDeps?: string[];
  isEntryPoint?: boolean;
  isTest?: boolean;
  isGenerated?: boolean;
  indexTier?: 'core' | 'support' | 'on_demand';
  mapperReason?: string;
  mtimeMs?: number | null;
}

/**
 * Structural upsert used by the automatic source scanner. Semantic state is
 * deliberately absent from `files`; generations and item hashes live in the
 * central semantic ledger.
 */
export function upsertStructural(
  db: DB,
  projectId: number,
  data: UpsertStructuralData,
): { fileId: number; created: boolean } {
  const tx = db.transaction(() => {
    const existing = db.prepare(
      'SELECT id FROM files WHERE project_id = ? AND path = ?'
    ).get(projectId, data.path) as { id: number } | undefined;

    if (existing) {
      // COALESCE keeps the stored dependency JSON when tree-sitter does not
      // support a language.
      db.prepare(`
        UPDATE files SET
          language = ?, size = ?, line_count = ?, content_hash = ?,
          dependencies = COALESCE(?, dependencies),
          internal_deps = COALESCE(?, internal_deps),
          external_deps = COALESCE(?, external_deps),
          is_entry_point = COALESCE(?, is_entry_point),
          is_test = COALESCE(?, is_test),
          is_generated = COALESCE(?, is_generated),
          index_tier = COALESCE(?, index_tier),
          mapper_reason = COALESCE(?, mapper_reason),
          mtime_ms = COALESCE(?, mtime_ms),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        data.language, data.size, data.lineCount, data.contentHash,
        data.dependencies ? JSON.stringify(data.dependencies) : null,
        data.internalDeps ? JSON.stringify(data.internalDeps) : null,
        data.externalDeps ? JSON.stringify(data.externalDeps) : null,
        data.isEntryPoint === undefined ? null : Number(data.isEntryPoint),
        data.isTest === undefined ? null : Number(data.isTest),
        data.isGenerated === undefined ? null : Number(data.isGenerated),
        data.indexTier ?? null, data.mapperReason ?? null,
        data.mtimeMs ?? null,
        existing.id
      );
      return { fileId: existing.id, created: false };
    }

    const result = db.prepare(`
      INSERT INTO files (project_id, path, language, size, line_count, content_hash,
        dependencies, internal_deps, external_deps,
        is_entry_point, is_test, is_generated, index_tier, mapper_reason, mtime_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId, data.path, data.language, data.size, data.lineCount, data.contentHash,
      JSON.stringify(data.dependencies ?? []), JSON.stringify(data.internalDeps ?? []),
      JSON.stringify(data.externalDeps ?? []),
      Number(data.isEntryPoint ?? false), Number(data.isTest ?? false),
      Number(data.isGenerated ?? false),
      data.indexTier ?? null, data.mapperReason ?? null,
      data.mtimeMs ?? null
    );
    return { fileId: result.lastInsertRowid as number, created: true };
  });

  return tx();
}
