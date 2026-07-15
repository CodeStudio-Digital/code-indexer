import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DbQueryToolView } from '../DbQueryToolView.js';

const input = { connection: 'reporting', sql: 'SELECT 1 AS id' };

describe('DbQueryToolView result display', () => {
  it('opens Markdown results in preview mode without renderer metadata', () => {
    const html = renderToStaticMarkup(createElement(DbQueryToolView, {
      input,
      result: { content: '| id | name |\n| --- | --- |\n| 1 | Ada |\nrows=1 truncated=false' },
    }));

    expect(html).toContain('data-result-preview="true"');
    expect(html).toContain('<table>');
    expect(html).not.toContain('rows=1 truncated=false');
  });

  it('keeps JSON raw by default and exposes the optional pretty mode', () => {
    const html = renderToStaticMarkup(createElement(DbQueryToolView, {
      input,
      result: { content: '{"id":1}' },
    }));

    expect(html).toContain('{&quot;id&quot;:1}</pre>');
    expect(html).toContain('>Pretty</button>');
  });
});
