import type { HybridSearchResult } from '@mcp/shared/types.js';
import type { SearchDiagnostics } from '@mcp/indexer/search/hybrid.js';
import type { McpSemanticSearchClient } from '@mcp/indexer/agent-tools/semantic-client.js';
import type { ParityFixture } from './fixture.js';

/** The route's deterministic edges: semantic owner and namespace wake. */
export interface ParityFakes {
  semanticSearchClient: McpSemanticSearchClient;
  mutationSinkWake: (namespace: string) => void;
  semanticCalls: unknown[];
  wakeCalls: string[];
  /** N2: every semantic call answers as an unavailable owner. */
  offline: boolean;
}

const DIAGNOSTICS = {
  vectorAvailable: true, embeddingAvailable: true, requestedMode: 'hybrid', plannedMode: 'hybrid', effectiveMode: 'hybrid',
} as SearchDiagnostics;

function waitForAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

export function makeFakes(fx: ParityFixture): ParityFakes {
  const symbolRow = (name: string) => fx.db.raw()
    .prepare('SELECT * FROM symbols WHERE project_id = ? AND name = ?').get(fx.main.id, name) as HybridSearchResult['data'];
  const hit = (name: string, score: number): HybridSearchResult => {
    const data = symbolRow(name);
    return { id: data.id, type: 'symbol', score, fts_rank: null, vector_score: score, data };
  };
  const fakes: ParityFakes = {
    semanticCalls: [], wakeCalls: [], offline: false,
    semanticSearchClient: {
      async searchProject(projectId, query, options = {}) {
        const { mode, type, limit, sessionId, companySessionId } = options;
        fakes.semanticCalls.push({ projectId, query, mode, type, limit, sessionId, companySessionId });
        if (query === 'hang') return waitForAbort(options.signal);
        if (fakes.offline || query === 'offline') return { ok: false, value: null, error: 'offline' };
        const results = query === 'widget shape' ? [hit('Widget', 0.91), hit('Shape', 0.83)] : [];
        return { ok: true, value: { results, diagnostics: DIAGNOSTICS }, error: null };
      },
      async searchProjectMemory(projectId, query, limit) {
        fakes.semanticCalls.push({ projectId, query, limit, memory: true });
        if (fakes.offline || query === 'offline') return { ok: false, value: null, error: 'offline' };
        const results = query === 'decision' ? fx.ids.memories.map((id, i) => ({ id, score: 0.9 - i / 10 })) : [];
        return { ok: true, value: { results }, error: null };
      },
    },
    mutationSinkWake: (namespace) => { fakes.wakeCalls.push(namespace); },
  };
  return fakes;
}
