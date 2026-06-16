/**
 * Coverage for the section chunker's anchor handling + its integration with
 * the code/table-aware packer.
 */
import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from '../section-chunker.js';

describe('chunkMarkdown', () => {
  it('extracts {#id} into anchor and strips it from heading_path', () => {
    const md = `# Guide {#guide}\n\n${'a'.repeat(80)}\n\n## Button {#button-api}\n\n${'b'.repeat(80)}`;
    const chunks = chunkMarkdown(md);
    const button = chunks.find((c) => c.heading_path.endsWith('Button'));
    expect(button).toBeDefined();
    expect(button!.heading_path).not.toContain('{#');
    expect(button!.anchor).toBe('button-api');
  });

  it('leaves anchor null when the heading has no {#id}', () => {
    const chunks = chunkMarkdown(`# Plain heading\n\n${'c'.repeat(80)}`);
    expect(chunks[0]!.anchor).toBeNull();
  });

  it('does not split a fenced code block across chunks', () => {
    const code = '```ts\n' + 'let n = 0;\n'.repeat(60) + '```';
    const chunks = chunkMarkdown(`# API {#api}\n\n${code}`, { maxChars: 200 });
    const withCode = chunks.filter((c) => c.content.includes('```'));
    // The fence opens and closes within a single chunk.
    for (const c of withCode) {
      const fences = c.content.match(/```/g)?.length ?? 0;
      expect(fences % 2).toBe(0);
    }
  });
});
