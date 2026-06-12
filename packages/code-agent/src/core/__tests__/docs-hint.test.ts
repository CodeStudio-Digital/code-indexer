/**
 * Coverage for the `<indexed-docs>` per-turn block (docs-hint.ts):
 *   - silent (null) without a provider / projectId / linked collections;
 *   - renders one line per collection + tool guidance;
 *   - 30s TTL cache — the provider is hit once per project per window.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildIndexedDocsBlock,
  setGlobalDocsHintProvider,
  type DocsHintCollection,
} from '@mcp/code-agent/core/docs-hint.js';

afterEach(() => setGlobalDocsHintProvider(null));

function provider(collections: DocsHintCollection[]) {
  const listForProject = vi.fn(() => collections);
  setGlobalDocsHintProvider({ listForProject });
  return listForProject;
}

describe('buildIndexedDocsBlock', () => {
  it('is null without a provider or without a projectId', () => {
    expect(buildIndexedDocsBlock(1)).toBeNull();
    provider([{ name: 'x', description: null, chunk_count: 1 }]);
    expect(buildIndexedDocsBlock(undefined)).toBeNull();
  });

  it('is null when the project has no linked collections', () => {
    provider([]);
    expect(buildIndexedDocsBlock(1)).toBeNull();
  });

  it('renders collections with descriptions, counts and tool guidance', () => {
    provider([
      { name: 'react-docs', description: 'React 19 official docs', chunk_count: 1204 },
      { name: 'unity-docs', description: null, chunk_count: 88 },
    ]);
    const block = buildIndexedDocsBlock(7);
    expect(block).toContain('<indexed-docs>');
    expect(block).toContain('- react-docs — React 19 official docs (1204 sections)');
    expect(block).toContain('- unity-docs (88 sections)');
    expect(block).toContain('rag_search_docs');
    expect(block).toContain('rag_read_doc');
    expect(block).toContain('docs_deep_research');
  });

  it('caches the rendered block per project within the TTL', () => {
    const fn = provider([{ name: 'a', description: null, chunk_count: 1 }]);
    buildIndexedDocsBlock(1);
    buildIndexedDocsBlock(1);
    buildIndexedDocsBlock(2);
    expect(fn).toHaveBeenCalledTimes(2); // once per project, second call cached
  });

  it('swallows provider errors as a silent null', () => {
    setGlobalDocsHintProvider({
      listForProject: () => {
        throw new Error('boom');
      },
    });
    expect(buildIndexedDocsBlock(1)).toBeNull();
  });
});
