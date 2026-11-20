/**
 * Coverage for the citation utilities — extract footnote markers from
 * synthesized markdown and map them back to chunk ids.
 */
import { describe, it, expect } from 'vitest';
import { normalizeFootnotes } from '../retrieval/citations.js';

it('keeps footnotes aligned with the returned citation list', () => {
  expect(normalizeFootnotes('Current [^42], previous [^77].\n[^77]: previous', [42, 77]))
    .toBe('Current [^1], previous [^2].\n[^2]: previous');
  expect(normalizeFootnotes('Current [^1] and [^2]', [42, 77])).toBe('Current [^1] and [^2]');
  expect(normalizeFootnotes('Unknown [^91]', [42])).toBeNull();
});
import {
  extractCitedIndices,
  resolveCitedChunkIds,
  formatCitation,
  buildBibliography,
} from '../retrieval/citations.js';
import type { DocChunk } from '@mcp/store/doc-store.js';

function makeChunk(id: number, heading: string | null = `Heading ${id}`): DocChunk {
  return {
    id,
    collection_id: 1,
    source_id: 10,
    ord: id,
    heading_path: heading,
    content: `content-${id}`,
    content_hash: `hash-${id}`,
    summary: null,
    concepts: [],
    token_count: 0,
    embedding_hash: null,
    embedding_provider_id: null,
    source_uri: `https://example.com/${id}`,
    doc_type: null,
    anchor: null,
    api_symbol: null,
    api_signature: null,
    created_at: new Date().toISOString(),
  };
}

describe('extractCitedIndices', () => {
  it('returns [] when no footnotes are present', () => {
    expect(extractCitedIndices('plain text with no markers')).toEqual([]);
  });

  it('extracts unique indices in order of first appearance', () => {
    const md = 'See [^2] and then [^1] and again [^2] and [^3].';
    expect(extractCitedIndices(md)).toEqual([2, 1, 3]);
  });

  it('ignores non-numeric footnote markers', () => {
    expect(extractCitedIndices('[^abc] is not a citation, but [^5] is.')).toEqual([5]);
  });

  it('drops 0 and negative indices defensively', () => {
    // The regex won't match a negative number (no `-`), but 0 is technically
    // matched — we drop it because chunk indices are 1-based.
    expect(extractCitedIndices('[^0] and [^1]')).toEqual([1]);
  });
});

describe('resolveCitedChunkIds', () => {
  const chunks = [makeChunk(101), makeChunk(202), makeChunk(303)];

  it('maps 1-based footnote indices back to chunk ids', () => {
    const md = '...as documented [^1]... see also [^3].';
    expect(resolveCitedChunkIds(md, chunks)).toEqual([101, 303]);
  });

  it('preserves the order in which footnotes first appear', () => {
    const md = '[^2] then [^1] then [^3]';
    expect(resolveCitedChunkIds(md, chunks)).toEqual([202, 101, 303]);
  });

  it('drops out-of-range indices silently', () => {
    const md = '[^1] and [^99]';
    expect(resolveCitedChunkIds(md, chunks)).toEqual([101]);
  });
});

describe('formatCitation', () => {
  it('renders heading_path and source_uri', () => {
    const out = formatCitation(makeChunk(1, 'Guide > Auth'), 1);
    expect(out).toContain('[^1]:');
    expect(out).toContain('Guide > Auth');
    expect(out).toContain('https://example.com/1');
  });

  it('falls back to "(untitled)" when heading_path is null', () => {
    const out = formatCitation(makeChunk(2, null), 2);
    expect(out).toContain('(untitled)');
  });
});

describe('buildBibliography', () => {
  it('returns empty string for no chunks', () => {
    expect(buildBibliography([])).toBe('');
  });

  it('builds N citation lines with sequential footnote indices', () => {
    const out = buildBibliography([makeChunk(10, 'A'), makeChunk(20, 'B')]);
    expect(out).toContain('[^1]:');
    expect(out).toContain('[^2]:');
    expect(out).toContain('A');
    expect(out).toContain('B');
  });
});
