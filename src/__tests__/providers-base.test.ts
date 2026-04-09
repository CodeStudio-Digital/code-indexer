import { describe, it, expect } from 'vitest';
import { parseAnalysisResponse } from '../core/indexer/providers/base.js';

const MINIMAL_VALID = {
  summary: 'A test file',
  concepts: ['test'],
  dependencies: [],
  internal_deps: [],
  external_deps: [],
  notes: [],
  complexity: 'low',
  symbols: [],
};

describe('parseAnalysisResponse', () => {
  it('parses direct JSON', () => {
    const r = parseAnalysisResponse(JSON.stringify(MINIMAL_VALID), 'a.ts');
    expect(r.summary).toBe('A test file');
    expect(r.concepts).toContain('test');
  });

  it('parses JSON inside fenced code block', () => {
    const fenced = '```json\n' + JSON.stringify(MINIMAL_VALID) + '\n```';
    const r = parseAnalysisResponse(fenced, 'a.ts');
    expect(r.summary).toBe('A test file');
  });

  it('parses JSON with preamble text', () => {
    const raw =
      'Here is the analysis:\n\n' + JSON.stringify(MINIMAL_VALID) + '\n\nEnd.';
    const r = parseAnalysisResponse(raw, 'a.ts');
    expect(r.summary).toBe('A test file');
  });

  it('returns fallback analysis on completely broken JSON', () => {
    const r = parseAnalysisResponse('not json at all', 'a.ts');
    expect(r).toBeDefined();
    expect(r.summary).toBeDefined();
  });

  it('returns fallback on truncated JSON', () => {
    const r = parseAnalysisResponse('{"summary": "oops', 'a.ts');
    expect(r).toBeDefined();
    expect(r.summary).toBeDefined();
  });

  it('handles JSON with nested braces in strings', () => {
    const payload = {
      ...MINIMAL_VALID,
      summary: 'Has { curly } braces {} in string',
    };
    const r = parseAnalysisResponse(JSON.stringify(payload), 'a.ts');
    expect(r.summary).toContain('curly');
  });
});
