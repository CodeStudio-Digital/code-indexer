import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { makeStructuralHarness } from '@mcp/indexer/indexer/__tests__/structural-test-harness.js';
import { NullEmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { HybridSearch } from '@mcp/indexer/search/hybrid.js';
import { FileSemanticSearchTelemetryStore } from '@mcp/indexer/search/search-telemetry.js';
import { searchTools } from '../search.js';
import type { IndexToolContext } from '../../context.js';

it('records local MCP FTS as agent search without persisting query or session contents', async () => {
  const h = makeStructuralHarness();
  try {
    h.writeFile('target.ts', 'export function auditPrivateIdentifier() { return 1; }\n');
    await h.indexStructural();
    const telemetry = new FileSemanticSearchTelemetryStore(id => id === h.projectId ? h.projectRoot : null);
    const hybridSearch = new HybridSearch(h.db, null, new NullEmbeddingService(), null, null, null, null, null, null, telemetry);
    const searchProject = vi.fn();
    const tool = searchTools.find(t => t.name === 'search')!;
    await tool.handler({ project_name: 'harness', query: 'auditPrivateIdentifier', type: 'symbols', mode: 'fts',
      __mcp_session_id: 'private-session-id', __mcp_company_session_id: 'private-company-id' },
    { db: h.db, hybridSearch, semanticSearchClient: { searchProject } } as unknown as IndexToolContext);
    await telemetry.flush();
    expect(searchProject).not.toHaveBeenCalled();
    await expect(telemetry.summarize(h.projectId)).resolves.toMatchObject({
      total_searches: 1, lexical_searches: 1, consumers: { agent: 1 }, opened_results: 0,
    });
    const raw = await readFile(join(h.projectRoot, '.mcp-indexer', 'metrics', 'semantic-search.jsonl'), 'utf8');
    expect(JSON.parse(raw.trim())).toMatchObject({ consumer: 'agent', session_scoped: true, result_count: 1 });
    expect(raw).not.toContain('auditPrivateIdentifier');
    expect(raw).not.toContain('private-session-id');
    expect(raw).not.toContain('private-company-id');
  } finally { h.dispose(); }
});
