/**
 * Coverage for the section chunker's anchor handling + its integration with
 * the code/table-aware packer.
 */
import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from '../section-chunker.js';
import { heuristicAccepts } from '../relevance-gate.js';

describe('chunkMarkdown', () => {
  it('keeps short references in the ingestion gate and in their original section', () => {
    const markdown = '# API\n\n## flush() {#flush}\n\nLimpa a fila.';
    expect(heuristicAccepts({ markdown } as never).accept).toBe(true);
    expect(chunkMarkdown(markdown)).toMatchObject([{ heading_path: 'API > flush()', anchor: 'flush', content: 'Limpa a fila.' }]);
  });

  it.each(['````', '~~~~'])('keeps shell comments and shorter delimiters inside %s', (fence: string) => {
    const example = [fence + 'sh', '# Exemplo interno', fence.slice(1), '# Dentro', fence + fence[0]].join('\n');
    const chunks = chunkMarkdown(['# Manual', '## Comando', example, '## Outro', 'Descrição breve.'].join('\n'), { maxChars: 16 });
    expect(chunks.map(c => c.heading_path)).toEqual(['Manual > Comando', 'Manual > Outro']);
    expect(chunks[0]!.content).toBe(example);
    expect(chunkMarkdown('# Manual\n' + fence + 'sh\n# Incompleto')[0]!.heading_path).toBe('Manual');
  });
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
