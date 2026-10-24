import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

const INVALID_HYDE_MODEL = '@cf/baai/bge-base-en-v1.5';
const DEFAULT_HYDE_MODEL = '@cf/meta/llama-3.2-3b-instruct';
const DEFAULT_HYDE_CONFIG = JSON.stringify({
  temperature: 0.2,
  max_tokens: 180,
  timeout_ms: 20_000,
});

function hasTable(db: DB, table: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table);
}

/**
 * Keep the provider-binding table aligned with the configurable catalog.
 *
 * Ten semantic-profile-owned targets never affected runtime, and five
 * per-axis Quality classifier bindings were retired. Their persisted rows
 * only made the admin UI look configured.
 *
 * The old bulk setup also assigned a BGE embedding model to HyDE. Repair that
 * exact legacy binding when the enabled Cloudflare text model is available;
 * otherwise disable it instead of leaving a knowingly uncallable route active.
 */
export const pipelineBindingCleanup261: Migration = {
  version: 261,
  name: 'pipeline_binding_cleanup',
  up(db: DB): void {
    if (!hasTable(db, 'pipeline_provider_bindings')) return;

    db.exec(`
      DELETE FROM pipeline_provider_bindings
       WHERE (pipeline_name = 'indexer_search'       AND binding_role = 'embedder')
          OR (pipeline_name = 'indexer_search'       AND binding_role = 'reranker')
          OR (pipeline_name = 'tool_selection'       AND binding_role = 'embedder')
          OR (pipeline_name = 'context_relevance'    AND binding_role = 'embedder')
          OR (pipeline_name = 'todo_priority'        AND binding_role = 'embedder')
          OR (pipeline_name = 'sub_agent_cache'      AND binding_role = 'embedder')
          OR (pipeline_name = 'role_pipeline'        AND binding_role = 'embedder')
          OR (pipeline_name = 'kanban_priority'      AND binding_role = 'embedder')
          OR (pipeline_name = 'quality_off_topic'    AND binding_role = 'classifier')
          OR (pipeline_name = 'quality_completeness' AND binding_role = 'classifier')
          OR (pipeline_name = 'quality_code'         AND binding_role = 'classifier')
          OR (pipeline_name = 'quality_policy'       AND binding_role = 'classifier')
          OR (pipeline_name = 'quality_tool_misuse'  AND binding_role = 'classifier')
          OR (pipeline_name = 'doc_ingest'           AND binding_role = 'embedder')
          OR (pipeline_name = 'doc_search'           AND binding_role = 'reranker');
    `);

    const hasInvalidHyde = !!db.prepare(`
      SELECT 1
        FROM pipeline_provider_bindings
       WHERE pipeline_name = 'indexer_search'
         AND binding_role = 'hyde'
         AND provider_id = 'cloudflare'
         AND model_id = ?
       LIMIT 1
    `).get(INVALID_HYDE_MODEL);
    if (!hasInvalidHyde) return;

    const hasProviders = hasTable(db, 'provider_configs') && hasTable(db, 'provider_models');
    const hasTextModel = hasProviders && !!db.prepare(`
      SELECT 1
        FROM provider_configs AS provider
        JOIN provider_models AS model
          ON model.provider_id = provider.id
       WHERE provider.id = 'cloudflare'
         AND provider.enabled = 1
         AND model.model_id = ?
         AND model.mode = ''
         AND model.enabled = 1
       LIMIT 1
    `).get(DEFAULT_HYDE_MODEL);

    if (!hasTextModel) {
      db.prepare(`
        UPDATE pipeline_provider_bindings
           SET enabled = 0,
               updated_at = datetime('now')
         WHERE pipeline_name = 'indexer_search'
           AND binding_role = 'hyde'
           AND provider_id = 'cloudflare'
           AND model_id = ?
      `).run(INVALID_HYDE_MODEL);
      return;
    }

    // Avoid colliding with an already-correct row in the same resolution
    // scope. The correct row wins; otherwise the legacy row is repaired.
    db.prepare(`
      DELETE FROM pipeline_provider_bindings AS invalid
       WHERE invalid.pipeline_name = 'indexer_search'
         AND invalid.binding_role = 'hyde'
         AND invalid.provider_id = 'cloudflare'
         AND invalid.model_id = ?
         AND EXISTS (
           SELECT 1
             FROM pipeline_provider_bindings AS valid
            WHERE valid.pipeline_name = invalid.pipeline_name
              AND valid.binding_role = invalid.binding_role
              AND valid.provider_id = invalid.provider_id
              AND valid.model_id = ?
              AND valid.model_mode = ''
              AND valid.scope_type = invalid.scope_type
              AND valid.scope_id IS invalid.scope_id
         )
    `).run(INVALID_HYDE_MODEL, DEFAULT_HYDE_MODEL);

    db.prepare(`
      UPDATE pipeline_provider_bindings
         SET model_id = ?,
             model_mode = '',
             config_json = ?,
             enabled = 1,
             updated_at = datetime('now')
       WHERE pipeline_name = 'indexer_search'
         AND binding_role = 'hyde'
         AND provider_id = 'cloudflare'
         AND model_id = ?
    `).run(DEFAULT_HYDE_MODEL, DEFAULT_HYDE_CONFIG, INVALID_HYDE_MODEL);
  },
};
