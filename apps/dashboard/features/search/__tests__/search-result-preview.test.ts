import { describe, expect, it } from 'vitest';
import type { HybridSearchResult } from '@mcp/shared/types.js';
import { structuralResultPreview } from '../search-result-preview.js';

describe('structuralResultPreview', () => {
  it('renders symbol signatures and comments without legacy summaries', () => {
    const result = {
      type: 'symbol',
      data: {
        signature: 'function resolveProject(id: number): Project',
        comment: 'Resolves the project from its stable id.',
        summary: 'legacy artificial summary',
      },
    } as unknown as HybridSearchResult;

    const preview = structuralResultPreview(result);
    expect(preview).toContain('function resolveProject');
    expect(preview).toContain('stable id');
    expect(preview).not.toContain('legacy artificial summary');
  });

  it('renders structural file metadata without legacy summaries or concepts', () => {
    const result = {
      type: 'file',
      data: {
        language: 'typescript',
        line_count: 120,
        summary: 'legacy artificial summary',
        concepts: '["dead"]',
      },
    } as unknown as HybridSearchResult;

    expect(structuralResultPreview(result)).toBe('typescript · 120 lines');
  });
});
