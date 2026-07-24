import { describe, expect, it } from 'vitest';
import { PIPELINE_CATALOG, setupTargetsForCapability } from '../catalog.js';

describe('semantic profile catalog ownership', () => {
  it('keeps HyDE as one optional live PipelineBinding', () => {
    const hyde = PIPELINE_CATALOG.filter(
      (entry) => entry.pipelineName === 'indexer_search' && entry.bindingRole === 'hyde',
    );

    expect(hyde).toHaveLength(1);
    expect(hyde[0]).toMatchObject({
      capabilityKind: 'text_llm',
      recommendedDefault: {
        providerKind: 'cloudflare',
        modelHint: '@cf/meta/llama-3.2-3b-instruct',
        config: { max_tokens: 180 },
      },
    });
    expect(hyde[0].comingSoon).toBeUndefined();
    expect(hyde[0].description).toContain('leave it unconfigured or disabled');
  });

  it('omits semantic-profile embedders from the provider-binding catalog', () => {
    const embedders = PIPELINE_CATALOG.filter((entry) => entry.bindingRole === 'embedder');
    expect(embedders).toEqual([]);
    expect(setupTargetsForCapability('embeddings')).toEqual([]);
  });

  it('separates profile cross-encoders from the independent memory LLM filter', () => {
    const code = PIPELINE_CATALOG.find(
      (entry) => entry.pipelineName === 'indexer_search' && entry.bindingRole === 'reranker',
    );
    const docs = PIPELINE_CATALOG.find(
      (entry) => entry.pipelineName === 'doc_search' && entry.bindingRole === 'reranker',
    );
    const memory = PIPELINE_CATALOG.find(
      (entry) => entry.pipelineName === 'memory_recall' && entry.bindingRole === 'reranker',
    );

    expect(code).toBeUndefined();
    expect(docs).toBeUndefined();
    expect(memory?.setupEligible).not.toBe(false);
    expect(setupTargetsForCapability('reranking')).toContainEqual(memory);
  });

  it('keeps retired and no-effect targets out of the catalog', () => {
    const retiredPairs = new Set([
      'indexer_search::embedder',
      'indexer_search::reranker',
      'tool_selection::embedder',
      'context_relevance::embedder',
      'todo_priority::embedder',
      'sub_agent_cache::embedder',
      'role_pipeline::embedder',
      'kanban_priority::embedder',
      'quality_off_topic::classifier',
      'quality_completeness::classifier',
      'quality_code::classifier',
      'quality_policy::classifier',
      'quality_tool_misuse::classifier',
      'doc_ingest::embedder',
      'doc_search::reranker',
    ]);
    const catalogPairs = new Set(
      PIPELINE_CATALOG.map((entry) => `${entry.pipelineName}::${entry.bindingRole}`),
    );

    expect(PIPELINE_CATALOG).toHaveLength(21);
    for (const pair of retiredPairs) expect(catalogPairs.has(pair)).toBe(false);
  });
});
