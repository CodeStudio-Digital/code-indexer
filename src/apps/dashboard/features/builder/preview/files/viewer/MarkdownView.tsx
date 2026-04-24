import React from 'react';
import { Markdown } from '../../../../chat/messages/Markdown.js';

/**
 * Thin wrapper around the app's existing <Markdown /> for rendering
 * `.md` / `.mdx` files inside the viewer. Scrolls independently and
 * pads the content — visual parity with the chat bubble.
 */
export function MarkdownView({ text }: { text: string }) {
  return (
    <div className="flex-1 overflow-auto px-4 py-3">
      <Markdown text={text} />
    </div>
  );
}
