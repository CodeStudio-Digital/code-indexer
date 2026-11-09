import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { RootContent } from 'hast';
import { describe, expect, it } from 'vitest';
import { MAX_MARKDOWN_ROW_NODES, parseMarkdownDocument } from '../markdown-document.js';

// Top-level block separators have no visual content and are not virtual rows.
const normalize = (html: string) => html.replace(/\n(?=<)/g, '').replace(/>\s+</g, '><');
function rendered(text: string) {
  const document = parseMarkdownDocument(text);
  return normalize(document.rows.map(row => renderToStaticMarkup(toJsxRuntime(row, { Fragment, jsx, jsxs }))).join(''));
}
const reference = (text: string) => normalize(renderToStaticMarkup(React.createElement(ReactMarkdown,
  { remarkPlugins: [remarkGfm], children: text })));
const nodes = (node: RootContent): number => 1 + (node.type === 'element' ? node.children.reduce((count, child) => count + nodes(child), 0) : 0);
function walk(rows: RootContent[]): RootContent[] {
  const all: RootContent[] = [];
  const pending = [...rows].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    all.push(node);
    if (node.type === 'element') pending.push(...[...node.children].reverse());
  }
  return all;
}

describe('worker Markdown semantics and safety', () => {
  it.each([
    '# Title\n\nParagraph with **bold**, *emphasis* and [cross-reference][target].\n\n[target]: https://example.org',
    '- item\n  - nested\n\n    paragraph\n- second\n\n> quote\n>\n> paragraph',
    '| A | B |\n| - | - |\n| x | y |\n\n~~deleted~~ and `inline`',
    '```ts\nconst x = 1;\n\n// unfinished fence',
    'A footnote[^1].\n\n[^1]: The definition.',
    '<img src=x onerror=alert(1)>\n\n[unsafe](javascript:alert) ![unsafe](data:text/html,abc) [relative](../safe)',
  ])('matches the existing full-document renderer: %s', text => {
    expect(rendered(text)).toBe(reference(text));
  });

  it('keeps references defined after a large document and escaped HTML safe', () => {
    const text = `${'A [reference][later].\n\n'.repeat(2000)}[later]: https://example.org\n\n<script>alert(1)</script>`;
    const document = parseMarkdownDocument(text);
    expect(document.rows.length).toBe(2001);
    expect(rendered(text)).toContain('href="https://example.org"');
    expect(rendered(text)).not.toContain('<script>');
  });

  it('bounds large ordered lists without resetting numbering or losing items', () => {
    const text = Array.from({ length: 1000 }, (_, index) => `${index + 5}. item-${index}`).join('\n');
    const document = parseMarkdownDocument(text);
    expect(document.rows).toHaveLength(63);
    expect(document.rows.every(row => row.type === 'element' && row.children.length <= 16)).toBe(true);
    const html = rendered(text);
    expect(html.match(/<li>/g)).toHaveLength(1000);
    expect(html).toContain('<ol start="21">');
    expect(html).toContain('item-999');
  });

  it('windows tables with headers and preserves all cells', () => {
    const text = '| A | B |\n| - | - |\n' + Array.from({ length: 300 }, (_, i) => `| row-${i} | value-${i} |`).join('\n');
    const document = parseMarkdownDocument(text);
    expect(document.rows.length).toBeGreaterThan(1);
    expect(rendered(text).match(/<td>/g)).toHaveLength(600);
    expect(rendered(text)).toContain('value-299');
  });

  it.each([
    (items: string) => '- outer\n' + items,
    (items: string) => '> - outer\n' + items.split('\n').map(line => `> ${line}`).join('\n'),
  ])('bounds a thousand nested list children inside one outer item or quote', wrap => {
    const text = wrap(Array.from({ length: 1000 }, (_, index) => `  - item-${index}`).join('\n'));
    const document = parseMarkdownDocument(text);
    expect(document.rows.length).toBeGreaterThan(1);
    expect(document.rows.every(row => nodes(row) <= MAX_MARKDOWN_ROW_NODES)).toBe(true);
    const html = rendered(text);
    expect(html.match(/item-\d+/g)).toEqual(Array.from({ length: 1000 }, (_, index) => `item-${index}`));
    expect(html.match(/outer/g)).toHaveLength(1);
    expect(html).toContain('list-style-type:none');
  });

  it('keeps original ordered-item values when a logical item continues across virtual rows', () => {
    const text = '5. Outer\n' + Array.from({ length: 1000 }, (_, index) => `   - nested-${index}`).join('\n') + '\n6. Final';
    const document = parseMarkdownDocument(text);
    expect(document.rows.every(row => nodes(row) <= MAX_MARKDOWN_ROW_NODES)).toBe(true);
    const html = rendered(text);
    expect(html.match(/nested-\d+/g)).toHaveLength(1000);
    expect(html).toContain('value="5"');
    const finalRow = document.rows.find(row => JSON.stringify(row).includes('Final'));
    expect(finalRow?.type).toBe('element');
    if (finalRow?.type === 'element') expect(Number(finalRow.properties.start)).toBeGreaterThanOrEqual(5);
    expect(html.match(/Final/g)).toHaveLength(1);
  });

  it('splits a giant inline paragraph without dropping emphasis, reference targets or textual order', () => {
    const tokens = Array.from({ length: 1500 }, (_, index) => `token-${index}`);
    const text = '**' + tokens.map(token => `[${token}][target]`).join(' ') + '**\n\n[target]: https://example.org/path';
    const document = parseMarkdownDocument(text);
    expect(document.rows.length).toBeGreaterThan(1);
    expect(document.rows.every(row => nodes(row) <= MAX_MARKDOWN_ROW_NODES)).toBe(true);
    const html = rendered(text);
    expect(html.match(/token-\d+/g)).toEqual(tokens);
    const links = walk(document.rows).filter(node => node.type === 'element' && node.tagName === 'a');
    expect(links).toHaveLength(1500);
    expect(links.every(node => node.type === 'element' && node.properties.href === 'https://example.org/path')).toBe(true);
    expect(document.rows.every(row => row.type === 'element' && row.tagName === 'p'
      && row.children.every(child => child.type === 'element' && child.tagName === 'strong'))).toBe(true);
  });

  it('bounds a giant table cell with valid row/cell wrappers, repeated headers and no duplicated body text', () => {
    const tokens = Array.from({ length: 1000 }, (_, index) => `value-${index}`);
    const text = '| A | B |\n| - | - |\n| ' + tokens.map(token => `[${token}](https://example.org)`).join(' ') + ' | final-cell |';
    const document = parseMarkdownDocument(text);
    expect(document.rows.length).toBeGreaterThan(1);
    expect(document.rows.every(row => nodes(row) <= MAX_MARKDOWN_ROW_NODES)).toBe(true);
    const html = rendered(text);
    expect(html.match(/value-\d+/g)).toEqual(tokens);
    expect(html.match(/final-cell/g)).toHaveLength(1);
    expect(document.rows.every(row => row.type === 'element' && row.tagName === 'table'
      && row.children.some(child => child.type === 'element' && child.tagName === 'thead'))).toBe(true);
    for (const node of walk(document.rows)) if (node.type === 'element' && node.tagName === 'tr') {
      expect(node.children.every(child => child.type === 'text' && !child.value.trim()
        || child.type === 'element' && (child.tagName === 'td' || child.tagName === 'th'))).toBe(true);
    }
  });

  it('bounds even oversized headers and preserves each column label/data without an unbounded repeated header', () => {
    const labels = Array.from({ length: 300 }, (_, index) => `column-${index}`);
    const text = '| ' + labels.join(' | ') + ' |\n| ' + labels.map(() => '-').join(' | ') + ' |\n| ' + labels.map((_, index) => `cell-${index}`).join(' | ') + ' |';
    const document = parseMarkdownDocument(text);
    expect(document.rows.every(row => nodes(row) <= MAX_MARKDOWN_ROW_NODES)).toBe(true);
    const html = rendered(text);
    expect(html.match(/column-\d+/g)).toEqual(labels);
    expect(html.match(/cell-\d+/g)).toEqual(labels.map((_, index) => `cell-${index}`));
  });

  it('keeps split footnote IDs unique and points the anchor map to the first retained fragment', () => {
    const text = 'Reference[^large].\n\n[^large]: ' + Array.from({ length: 1000 }, (_, index) => `[foot-${index}](https://example.org)`).join(' ');
    const document = parseMarkdownDocument(text);
    const ids = walk(document.rows).flatMap(node => node.type === 'element' && typeof node.properties.id === 'string' ? [node.properties.id] : []);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('user-content-fn-large');
    expect(document.rows.every(row => nodes(row) <= MAX_MARKDOWN_ROW_NODES)).toBe(true);
    expect(document.anchors['user-content-fn-large']).toBeGreaterThanOrEqual(0);
    expect(rendered(text).match(/foot-\d+/g)).toHaveLength(1000);
  });
});
