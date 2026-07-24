import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { pipelineBindingCleanup261 } from '../261_pipeline_binding_cleanup.js';

let db: InstanceType<typeof Database>;

function createFixture(opts: { withTextModel?: boolean } = {}): void {
  db.exec(`
    CREATE TABLE provider_configs (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL
    );
    CREATE TABLE provider_models (
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL
    );
    CREATE TABLE pipeline_provider_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_name TEXT NOT NULL,
      binding_role TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_mode TEXT NOT NULL DEFAULT '',
      config_json TEXT NOT NULL DEFAULT '{}',
      scope_type TEXT NOT NULL DEFAULT 'global',
      scope_id INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO provider_configs (id, enabled) VALUES ('cloudflare', 1);
    INSERT INTO provider_models (provider_id, model_id, mode, enabled) VALUES
      ('cloudflare', '@cf/baai/bge-base-en-v1.5', '', 1);
  `);
  if (opts.withTextModel !== false) {
    db.prepare(`
      INSERT INTO provider_models (provider_id, model_id, mode, enabled)
      VALUES ('cloudflare', '@cf/meta/llama-3.2-3b-instruct', '', 1)
    `).run();
  }
}

function insertBinding(
  pipelineName: string,
  bindingRole: string,
  modelId = 'test-model',
  enabled = 1,
): void {
  db.prepare(`
    INSERT INTO pipeline_provider_bindings (
      pipeline_name, binding_role, provider_id, model_id, enabled
    ) VALUES (?, ?, 'cloudflare', ?, ?)
  `).run(pipelineName, bindingRole, modelId, enabled);
}

beforeEach(() => {
  db = new Database(':memory:');
});

afterEach(() => db?.close());

describe('migration 261 - pipeline binding cleanup', () => {
  it('removes retired targets and repairs the legacy HyDE embedding binding', () => {
    createFixture();
    const retired: Array<[string, string]> = [
      ['indexer_search', 'embedder'],
      ['indexer_search', 'reranker'],
      ['tool_selection', 'embedder'],
      ['context_relevance', 'embedder'],
      ['todo_priority', 'embedder'],
      ['sub_agent_cache', 'embedder'],
      ['role_pipeline', 'embedder'],
      ['kanban_priority', 'embedder'],
      ['quality_off_topic', 'classifier'],
      ['quality_completeness', 'classifier'],
      ['quality_code', 'classifier'],
      ['quality_policy', 'classifier'],
      ['quality_tool_misuse', 'classifier'],
      ['doc_ingest', 'embedder'],
      ['doc_search', 'reranker'],
    ];
    for (const [pipeline, role] of retired) insertBinding(pipeline, role);
    insertBinding('quality_delivery', 'classifier');
    insertBinding('indexer_search', 'hyde', '@cf/baai/bge-base-en-v1.5');
    // Disabled user choices outside the retired set are deliberately not
    // deleted by the global migration.
    insertBinding('editor', 'autocomplete', 'old-editor-model', 0);

    pipelineBindingCleanup261.up(db);
    pipelineBindingCleanup261.up(db);

    expect(db.prepare(`
      SELECT pipeline_name, binding_role, model_id, enabled, config_json
        FROM pipeline_provider_bindings
       ORDER BY pipeline_name, binding_role
    `).all()).toEqual([
      {
        pipeline_name: 'editor',
        binding_role: 'autocomplete',
        model_id: 'old-editor-model',
        enabled: 0,
        config_json: '{}',
      },
      {
        pipeline_name: 'indexer_search',
        binding_role: 'hyde',
        model_id: '@cf/meta/llama-3.2-3b-instruct',
        enabled: 1,
        config_json: '{"temperature":0.2,"max_tokens":180,"timeout_ms":20000}',
      },
      {
        pipeline_name: 'quality_delivery',
        binding_role: 'classifier',
        model_id: 'test-model',
        enabled: 1,
        config_json: '{}',
      },
    ]);
  });

  it('disables the invalid HyDE binding when no text model is available', () => {
    createFixture({ withTextModel: false });
    insertBinding('indexer_search', 'hyde', '@cf/baai/bge-base-en-v1.5');

    pipelineBindingCleanup261.up(db);

    expect(db.prepare(`
      SELECT model_id, enabled
        FROM pipeline_provider_bindings
       WHERE pipeline_name = 'indexer_search' AND binding_role = 'hyde'
    `).get()).toEqual({
      model_id: '@cf/baai/bge-base-en-v1.5',
      enabled: 0,
    });
  });

  it('is a no-op for trimmed databases without the bindings table', () => {
    expect(() => pipelineBindingCleanup261.up(db)).not.toThrow();
  });
});
