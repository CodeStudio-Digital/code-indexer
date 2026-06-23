/**
 * F4 — the agent-facing diagnostics trailer: zero results must say WHY
 * (vector down vs genuinely nothing), degraded results must be labeled,
 * healthy results must stay untouched.
 */
import { describe, expect, it } from 'vitest';
import {
  renderDegradedTrailer,
  renderZeroResultDiagnostics,
  vectorIssue,
} from '../search-diagnostics.js';
import type { SearchDiagnostics } from '@mcp/indexer/search/hybrid.js';

const healthy: SearchDiagnostics = {
  vectorAvailable: true,
  embeddingAvailable: true,
  ftsCount: 0,
  vectorRawMatches: 0,
};

describe('vectorIssue', () => {
  it('maps degradation causes to stable reason codes', () => {
    expect(vectorIssue(healthy)).toBeNull();
    expect(vectorIssue({ ...healthy, vectorAvailable: false })).toBe('vector_store_unavailable');
    expect(vectorIssue({ ...healthy, embeddingAvailable: false })).toBe('embedding_unavailable');
    expect(vectorIssue({ ...healthy, vectorError: 'timeout after 60000ms' }))
      .toBe('vector_error: timeout after 60000ms');
  });
});

describe('renderZeroResultDiagnostics', () => {
  const fullCoverage = () => ({ files_total: 10, files_embedded: 10 });

  it('healthy zero-result reports streams without scare text', () => {
    const out = renderZeroResultDiagnostics('hybrid', healthy, fullCoverage);
    expect(out).toContain('No results found.');
    expect(out).toContain('[diagnostics]');
    expect(out).toContain('vector=ok');
    expect(out).not.toContain('grep_code');
  });

  it('vector failure tells the agent absence is not evidence + suggests grep_code', () => {
    const out = renderZeroResultDiagnostics(
      'hybrid',
      { ...healthy, vectorError: 'Embedding API timeout' },
      fullCoverage,
    );
    expect(out).toContain('vector=failed: vector_error: Embedding API timeout');
    expect(out).toContain('grep_code');
    expect(out).toContain('does NOT mean');
  });

  it('partial embedding coverage is surfaced', () => {
    const out = renderZeroResultDiagnostics('hybrid', healthy, () => ({ files_total: 1900, files_embedded: 812 }));
    expect(out).toContain('812/1900');
  });

  it('planner-resolved mode is shown; coverage errors never break the result', () => {
    const out = renderZeroResultDiagnostics(
      'auto',
      { ...healthy, plannerMode: 'fts', plannerReason: 'identifier-shaped' },
      () => { throw new Error('db gone'); },
    );
    expect(out).toContain('mode=fts (planner: identifier-shaped)');
  });
});

describe('renderDegradedTrailer', () => {
  it('null when healthy, one-line note when the vector stream failed', () => {
    expect(renderDegradedTrailer(healthy)).toBeNull();
    const trailer = renderDegradedTrailer({ ...healthy, embeddingAvailable: false });
    expect(trailer).toContain('FTS-only');
    expect(trailer).toContain('embedding_unavailable');
  });
});
