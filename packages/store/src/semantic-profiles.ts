import { hydrateProfile, hydrateModel } from './semantic-store-values.js';
import type { SemanticPurpose, SemanticCapability, EmbeddingTarget, RerankerTarget, SemanticProfileRow, SemanticModelStatus, SemanticModelCatalogRow, JsonProfileRow, JsonModelRow } from './semantic-store-types.js';

import type { DB } from './semantic-store-types.js';

export class SemanticProfiles {
  constructor(private readonly db: DB) {}

  listProfiles(): SemanticProfileRow[] {
    return (this.db.prepare(`SELECT * FROM semantic_profiles ORDER BY purpose`).all() as JsonProfileRow[])
      .map(hydrateProfile);
  }

  getProfile(purpose: SemanticPurpose): SemanticProfileRow | null {
    const row = this.db.prepare(`SELECT * FROM semantic_profiles WHERE purpose = ?`).get(purpose) as
      | JsonProfileRow
      | undefined;
    return row ? hydrateProfile(row) : null;
  }

  upsertProfile(input: {
    purpose: SemanticPurpose;
    embedding_target: EmbeddingTarget;
    reranker_target: RerankerTarget;
  }): SemanticProfileRow {
    this.db.prepare(`
      INSERT INTO semantic_profiles (purpose, embedding_target, reranker_target)
      VALUES (?, ?, ?)
      ON CONFLICT(purpose) DO UPDATE SET
        embedding_target = excluded.embedding_target,
        reranker_target = excluded.reranker_target,
        updated_at = datetime('now')
    `).run(input.purpose, JSON.stringify(input.embedding_target), JSON.stringify(input.reranker_target));
    return this.getProfile(input.purpose)!;
  }

  listModels(filter: { capability?: SemanticCapability; source?: SemanticModelCatalogRow['source'] } = {}): SemanticModelCatalogRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.capability) { where.push('capability = ?'); params.push(filter.capability); }
    if (filter.source) { where.push('source = ?'); params.push(filter.source); }
    const sql = `SELECT * FROM semantic_model_catalog${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY capability, source, model_id`;
    return (this.db.prepare(sql).all(...params) as JsonModelRow[]).map(hydrateModel);
  }

  upsertModel(input: {
    id: string;
    capability: SemanticCapability;
    source: SemanticModelCatalogRow['source'];
    provider_id?: string | null;
    model_id: string;
    config?: Record<string, unknown>;
    dimension?: number | null;
    status?: SemanticModelStatus;
    last_probe_error?: string | null;
  }): SemanticModelCatalogRow {
    this.db.prepare(`
      INSERT INTO semantic_model_catalog
        (id, capability, source, provider_id, model_id, config, dimension, status, last_probe_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        capability = excluded.capability, source = excluded.source,
        provider_id = excluded.provider_id, model_id = excluded.model_id,
        config = excluded.config, dimension = excluded.dimension,
        status = excluded.status, last_probe_error = excluded.last_probe_error,
        updated_at = datetime('now')
    `).run(
      input.id, input.capability, input.source, input.provider_id ?? null, input.model_id,
      JSON.stringify(input.config ?? {}), input.dimension ?? null, input.status ?? 'unknown',
      input.last_probe_error ?? null,
    );
    const row = this.db.prepare(`SELECT * FROM semantic_model_catalog WHERE id = ?`).get(input.id) as JsonModelRow;
    return hydrateModel(row);
  }

  recordModelProbe(id: string, result: { ok: boolean; dimension?: number | null; error?: string | null }): SemanticModelCatalogRow | null {
    this.db.prepare(`
      UPDATE semantic_model_catalog SET
        status = ?, dimension = COALESCE(?, dimension), last_probe_at = datetime('now'),
        last_probe_error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(result.ok ? 'ready' : 'error', result.dimension ?? null, result.ok ? null : (result.error ?? 'probe failed'), id);
    const row = this.db.prepare(`SELECT * FROM semantic_model_catalog WHERE id = ?`).get(id) as JsonModelRow | undefined;
    return row ? hydrateModel(row) : null;
  }

  deleteModel(id: string): number {
    return this.db.prepare(`DELETE FROM semantic_model_catalog WHERE id = ?`).run(id).changes;
  }
}
