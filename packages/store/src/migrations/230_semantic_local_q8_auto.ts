/** Migration 230 — make the managed local targets explicit and adaptive.
 * Existing generations remain immutable; changing the desired embedding
 * target to q8 intentionally requires a new generation on next project open. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, name: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(name);
}

export const semanticLocalQ8Auto230: Migration = {
  version: 230,
  name: 'semantic_local_q8_auto',
  up(db: DB): void {
    if (!tableExists(db, 'semantic_profiles')) return;
    db.prepare(`
      UPDATE semantic_profiles
      SET embedding_target = json_set(embedding_target, '$.dtype', 'q8'),
          updated_at = datetime('now')
      WHERE json_extract(embedding_target, '$.kind') = 'onnx'
        AND json_extract(embedding_target, '$.model') = 'Xenova/multilingual-e5-small'
        AND json_type(embedding_target, '$.dtype') IS NULL
    `).run();
    db.prepare(`
      UPDATE semantic_profiles
      SET reranker_target = json_set(
            json_set(reranker_target, '$.model', 'auto'),
            '$.dtype', 'q8'
          ),
          updated_at = datetime('now')
      WHERE json_extract(reranker_target, '$.kind') = 'onnx'
        AND json_extract(reranker_target, '$.model') = 'Xenova/bge-reranker-base'
        AND json_type(reranker_target, '$.dtype') IS NULL
    `).run();

    if (tableExists(db, 'semantic_model_catalog')) {
      db.prepare(`
        INSERT OR IGNORE INTO semantic_model_catalog
          (id, capability, source, model_id, config, status)
        VALUES (
          'onnx:rerank:auto', 'rerank', 'default', 'auto',
          '{"kind":"onnx","model":"auto","dtype":"q8","maxTokens":512}',
          'unknown'
        )
      `).run();
    }
  },
};

