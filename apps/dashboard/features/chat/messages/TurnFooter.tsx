import type { ReactNode } from 'react';
import { CopyMarkdownButton } from './CopyMarkdownButton.js';
import type { ReadMarkdown } from './round-markdown.js';

export function TurnFooter({ copyMarkdown, children }: { copyMarkdown?: ReadMarkdown; children?: ReactNode }) {
  return <footer data-turn-footer className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 py-1">
    {children && <div className="me-auto min-w-0">{children}</div>}
    {copyMarkdown && <CopyMarkdownButton text={copyMarkdown} />}
  </footer>;
}
