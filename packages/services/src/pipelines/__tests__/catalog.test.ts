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
      recommendedDefault: { config: { max_tokens: 180 } },
    });
    expect(hyde[0].comingSoon).toBeUndefined();
    expect(hyde[0].description).toContain('leave it unconfigured or disabled');
  });

  it('keeps every embedder informational and out of guided setup', () => {
    const embedders = PIPELINE_CATALOG.filter((entry) => entry.bindingRole === 'embedder');
    expect(embedders.length).toBeGreaterThan(0);
    expect(embedders.every((entry) => entry.setupEligible === false)).toBe(true);
    expect(embedders.every((entry) => entry.description.startsWith('INFORMATIONAL ONLY'))).toBe(true);
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

    expect(code).toMatchObject({ setupEligible: false });
    expect(docs).toMatchObject({ setupEligible: false });
    expect(code?.description).toMatch(/^INFORMATIONAL ONLY/);
    expect(docs?.description).toMatch(/^INFORMATIONAL ONLY/);
    expect(memory?.setupEligible).not.toBe(false);
    expect(setupTargetsForCapability('reranking')).toContainEqual(memory);
  });
});
