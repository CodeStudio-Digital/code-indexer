import { describe, expect, it } from 'vitest';
import { PRESETS, providerSupports } from '../presets.js';
import { WIZARD_BUCKETS } from '../use-setup-state.js';

describe('guided setup semantic-profile boundary', () => {
  it('does not offer embeddings or reranking as wizard buckets', () => {
    const kinds = WIZARD_BUCKETS.map((bucket) => bucket.kind);
    expect(kinds).not.toContain('embeddings');
    expect(kinds).not.toContain('reranking');
  });

  it('does not seed semantic pipeline bindings from presets', () => {
    for (const preset of PRESETS) {
      expect(preset.optionalOn).not.toContain('embeddings');
      expect(preset.optionalOn).not.toContain('reranking');
      expect(preset.buckets.embeddings).toBeUndefined();
      expect(preset.buckets.reranking).toBeUndefined();
    }
  });

  it('preserves provider capability descriptors for pipeline screens', () => {
    expect(providerSupports('embeddings', 'openai')).toBe(true);
    expect(providerSupports('reranking', 'anthropic')).toBe(true);
  });
});
