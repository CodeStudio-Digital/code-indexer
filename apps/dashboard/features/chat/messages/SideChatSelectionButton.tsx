import { useEffect, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { MessagesSquare } from 'lucide-react';
import type { SideChatSelection } from '@mcp/shared/side-chat.js';

function transcriptRow(node: Node | null) {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>('[data-side-source]');
}

export function SideChatSelectionButton({ root, sessionId }: { root: RefObject<HTMLDivElement | null>; sessionId: string }) {
  const { t } = useTranslation('chat');
  const [quote, setQuote] = useState<SideChatSelection | null>(null);
  useEffect(() => {
    const changed = () => {
      const selection = document.getSelection();
      const row = transcriptRow(selection?.anchorNode ?? null);
      const text = selection?.toString().trim() ?? '';
      if (!text || text.length > 4000 || !row || !root.current?.contains(row) || row !== transcriptRow(selection?.focusNode ?? null)) {
        setQuote(null); return;
      }
      setQuote({ seq: row.dataset.sideSource === 'live' ? null : Number(row.dataset.sideSource), text });
    };
    document.addEventListener('selectionchange', changed);
    return () => document.removeEventListener('selectionchange', changed);
  }, [root, sessionId]);
  if (!quote) return null;
  return <button type="button" className="absolute right-3 top-2 z-30 flex items-center gap-2 rounded-md border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow"
    onMouseDown={e => e.preventDefault()} onClick={() => {
      window.dispatchEvent(new CustomEvent('coder:ask-in-side-chat', { detail: { parentId: sessionId, key: crypto.randomUUID(), selection: quote } }));
      document.getSelection()?.removeAllRanges(); setQuote(null);
    }}><MessagesSquare size={14}/>{t('side.askSelection')}</button>;
}
