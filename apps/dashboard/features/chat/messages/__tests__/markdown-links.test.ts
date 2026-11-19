import { describe, expect, it } from 'vitest';
import type { Element } from 'hast';
import { markdownUrlTransform, parseFileLink } from '../markdown-links.js';
import { parseMarkdownDocument } from '../markdown-document.js';

const a: Element = { type: 'element', tagName: 'a', properties: {}, children: [] };
const img: Element = { ...a, tagName: 'img' };

describe('chat file links', () => {
  it.each([
    ['rea-webstorm-editor-language/README.md', { path: 'rea-webstorm-editor-language/README.md' }],
    ['file:///D:/Projeto/Relat%C3%B3rio%20final.md#introdu%C3%A7%C3%A3o', { path: 'D:/Projeto/Relatório final.md', fragment: 'introdução' }],
    ['D:%5CProjeto%5Cmain.ts:24:3', { path: 'D:/Projeto/main.ts', line: 24, column: 3 }],
    ['/D:/Projeto/main.ts#L12-L17', { path: 'D:/Projeto/main.ts', line: 12, column: 1 }],
    ['README.md:8', { path: 'README.md', line: 8, column: 1 }],
    ['docs/a%23b.md', { path: 'docs/a#b.md' }],
    ['/home/user/report.md', { path: '/home/user/report.md' }],
  ])('preserves %s in both Markdown renderers', (href, expected) => {
    const link = String(href);
    expect(parseFileLink(markdownUrlTransform(link, 'href', a))).toEqual(expected);
    const paragraph = parseMarkdownDocument('[open](' + link + ')').rows[0] as Element;
    expect(parseFileLink(String((paragraph.children[0] as Element).properties.href))).toEqual(expected);
  });

  it('resolves a reference inside a report from its own directory', () => {
    expect(parseFileLink('bytecode/index.tsv#L3', 'D:/project/docs/README.md')).toEqual({
      path: 'D:/project/docs/bytecode/index.tsv', line: 3, column: 1,
    });
  });

  it('keeps remote URLs, fragments, unsupported schemes and invalid paths out of the file reader', () => {
    for (const href of ['https://example.org', '//example.org/report', 'mailto:a@example.org', '#section', 'file://host/path',
      'data:text/html,contents', 'javascript:123', 'D:%5C%00', 'bad%xy', '%5c%5cserver%5cshare']) {
      expect(parseFileLink(href)).toBeNull();
    }
    expect(markdownUrlTransform('file:///D:/local', 'src', img)).toBe('');
    expect(markdownUrlTransform('javascript:123', 'href', a)).toBe('');
    expect(markdownUrlTransform('file://host/path', 'href', a)).toBe('');
  });

  it('indexes headings in reading order for virtualized documents', () => {
    expect(parseMarkdownDocument('# Índice\n\n## Um **título**\n\n## Um título').anchors)
      .toMatchObject({ índice: 0, 'um-título': 1, 'um-título-1': 2 });
  });
});
