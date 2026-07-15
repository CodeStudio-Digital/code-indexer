import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../Markdown.js';

describe('chat Markdown code blocks', () => {
  it('adds a copy action to fenced code without adding one to inline code', () => {
    const html = renderToStaticMarkup(createElement(Markdown, {
      text: 'Use `inline` here.\n\n```sql\nSELECT * FROM customers;\n```',
    }));

    expect(html).toContain('data-code-copy');
    expect(html).toContain('<span>sql</span>');
    expect(html).toContain('SELECT * FROM customers;');
    expect(html).toContain('<code>inline</code>');
  });

  it('starts large code blocks collapsed with an expand control', () => {
    const code = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join('\n');
    const html = renderToStaticMarkup(createElement(Markdown, { text: `\`\`\`text\n${code}\n\`\`\`` }));

    expect(html).toContain('data-code-expand="true"');
    expect(html).toContain('max-h-80 overflow-hidden');
  });
});
