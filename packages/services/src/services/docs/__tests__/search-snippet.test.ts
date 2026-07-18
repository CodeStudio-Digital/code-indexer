import { describe, expect, it } from 'vitest';
import type { DocChunk } from '@mcp/store/doc-store.js';
import { buildSnippet } from '../search.js';

describe('documentation search snippet boundary', () => {
  it('never splits an astral Unicode character at the 480-char preview edge', () => {
    const content = `${'a'.repeat(479)}🙂tail`;
    const snippet = buildSnippet({ content, summary: null } as DocChunk);

    expect(snippet.truncated).toBe(true);
    expect(snippet.text).toBe(`${'a'.repeat(479)}…`);
    expect(snippet.text).not.toContain('\uFFFD');
    expect(snippet.retainedChars).toBe(479);
    expect(snippet.sourceChars).toBe(content.length);
  });
});
