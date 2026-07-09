import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { cleanThinkingMarkdown, thinkingPreviewText } from '../thinking-text.js';

const SAMPLE = `**Investigating duplicate transaction handling in SIGER**

<!-- -->**Saving user preference for duplicate handling**

<!-- -->**Planning multi-tool calls for goal setup**

<!-- -->`;

describe('thinking render', () => {
  it('cleans provider summary separators without dropping markdown', () => {
    expect(cleanThinkingMarkdown(SAMPLE)).toBe(
      [
        '**Investigating duplicate transaction handling in SIGER**',
        '**Saving user preference for duplicate handling**',
        '**Planning multi-tool calls for goal setup**',
      ].join('\n\n'),
    );
    expect(thinkingPreviewText(SAMPLE)).toContain('Planning multi-tool calls');
  });

  it('renders reasoning summaries as markdown, not raw provider text', async () => {
    (globalThis as { React?: typeof React }).React = React;
    const { LiveThinkingBlock } = await import('../live-blocks.js');
    const html = renderToStaticMarkup(createElement(LiveThinkingBlock, { text: SAMPLE }));

    expect(html).toContain('<strong>Investigating duplicate transaction handling in SIGER</strong>');
    expect(html).not.toContain('&lt;!--');
    expect(html).not.toContain('<!--');
    expect(html).not.toContain('**Investigating');
  });
});
