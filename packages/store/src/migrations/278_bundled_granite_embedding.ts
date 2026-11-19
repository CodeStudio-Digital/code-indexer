import { BUNDLED_EMBEDDING_TARGET } from '@mcp/shared/providers/bundled-semantic-model.js';
import type { Migration } from './types.js';

export const bundledGraniteEmbedding278: Migration = {
  version: 278,
  name: 'bundled_granite_embedding',
  scope: 'central',
  up(db) {
    const target = BUNDLED_EMBEDDING_TARGET;
    // Only replace the old preset. Existing generations retain their own model
    // and vectors until a normal rebuild publishes a Granite generation.
    db.prepare(`
      UPDATE semantic_profiles SET embedding_target = ?, updated_at = datetime('now')
      WHERE json_extract(embedding_target, '$.kind') = 'onnx'
        AND json_extract(embedding_target, '$.model') = 'Xenova/multilingual-e5-small'
        AND COALESCE(json_extract(embedding_target, '$.dtype'), 'q8') = 'q8'
        AND COALESCE(json_extract(embedding_target, '$.pooling'), 'mean') = 'mean'
        AND COALESCE(json_extract(embedding_target, '$.normalize'), 1) = 1
        AND COALESCE(json_extract(embedding_target, '$.queryTemplate'), 'query: {text}') = 'query: {text}'
        AND COALESCE(json_extract(embedding_target, '$.documentTemplate'), 'passage: {text}') = 'passage: {text}'
        AND COALESCE(json_extract(embedding_target, '$.maxTokens'), 512) = 512
        AND NULLIF(json_extract(embedding_target, '$.cacheDir'), '') IS NULL
        AND NULLIF(json_extract(embedding_target, '$.revision'), '') IS NULL
    `).run(JSON.stringify(target));

    db.prepare(`
      INSERT OR IGNORE INTO semantic_model_catalog (id, capability, source, model_id, config, dimension)
      VALUES (?, 'embedding', 'onnx', ?, ?, 384)
    `).run(`onnx:embedding:${target.model}`, target.model, JSON.stringify({ target, bundled: true }));
  },
};
