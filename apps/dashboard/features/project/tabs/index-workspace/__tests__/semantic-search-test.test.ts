import { describe, expect, it } from 'vitest';
import {
  buildSemanticConsumerPreview,
  formatMcpSearchResult,
  semanticResultLine,
  semanticResultPath,
} from '../semantic-search-test.js';
import type { ProjectSemanticSearchTestResult } from '../project-semantic-api.js';

const result: ProjectSemanticSearchTestResult = {
  results: [{
    id: 7,
    type: 'symbol',
    score: 0.91,
    fts_rank: 2,
    vector_score: 0.82,
    data: {
      file_path: 'src/agents/resume.ts',
      name: 'resumeSession',
      kind: 'function',
      line: 42,
      signature: 'resumeSession(id: string)',
      comment: 'Retoma a sessão do agente.',
    },
  }],
  diagnostics: {
    vectorAvailable: true,
    embeddingAvailable: true,
    effectiveMode: 'hybrid',
    rerankerApplied: true,
  },
};

const input = { query: 'onde retoma o agente', mode: 'auto' as const, type: 'all' as const, limit: 20 };

describe('semantic search consumer previews', () => {
  it('formats the same structural fields exposed by the MCP search tool', () => {
    expect(formatMcpSearchResult(result)).toContain('## [symbol] resumeSession (function) — score: 0.910');
    expect(formatMcpSearchResult(result)).toContain('File: src/agents/resume.ts:42');
  });

  it('normalizes navigation data for Monaco', () => {
    expect(semanticResultPath(result.results[0])).toBe('src/agents/resume.ts');
    expect(semanticResultLine(result.results[0])).toBe(42);
    expect(buildSemanticConsumerPreview('monaco', 91, 'CodeStudio', input, result))
      .toContain('"action": "semantic_search"');
  });

  it('shows the exact tool contract presented to an agent', () => {
    const preview = buildSemanticConsumerPreview('agent', 91, 'CodeStudio', input, result);
    expect(preview).toContain('"tool": "mcp__search"');
    expect(preview).toContain('"project_name": "CodeStudio"');
    expect(preview).toContain('"rerankerApplied": true');
  });
});
