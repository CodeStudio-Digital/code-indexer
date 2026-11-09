import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Copy, Check, Loader2 } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import type { RootContent } from 'hast';
import { copyText } from '../../../lib/clipboard.js';
import { markdownWorkerQueue } from './markdown-worker-client.js';
import type { MarkdownDocument } from './markdown-document.js';
import { useTranscriptSelection } from './transcript-selection.js';

interface Props {
  text: string;
  preview: ReactNode;
  renderNode: (node: RootContent) => ReactNode;
}

/** Long answers have their own bounded reading viewport. Parsing stays off
 * the UI thread; the full source and copy action never use a truncated value. */
export function LargeMarkdown({ text, preview, renderNode }: Props) {
  'use no memo'; // TanStack Virtual exposes a mutable instance; do not compiler-memoize it.
  const { t } = useTranslation('chat');
  const [parsed, setParsed] = useState<{ document: MarkdownDocument; source: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const lease = useRef<ReturnType<typeof markdownWorkerQueue.acquire> | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const subscription = markdownWorkerQueue.acquire(result => {
      if (result.document && result.source !== undefined) { setParsed({ document: result.document, source: result.source }); setFailed(false); }
      else setFailed(true);
    });
    lease.current = subscription;
    return () => { subscription.dispose(); lease.current = null; };
  }, []);
  useEffect(() => { lease.current?.update(text); }, [text]);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const document = parsed && text.startsWith(parsed.source) ? parsed.document : null;
  const rows = document?.rows ?? [];
  const rowKeys = useMemo(() => document?.rows.map((_, index) => ({ key: `markdown-${index}` })) ?? [], [document]);
  const rangeExtractor = useTranscriptSelection(viewport, rowKeys);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is mutable; this component explicitly opts out of Compiler memoization.
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => viewport.current,
    estimateSize: () => 64, overscan: 4, rangeExtractor });

  return <div data-large-markdown data-markdown-ready={Boolean(document)} className="relative">
    <div className="not-prose flex items-center justify-end gap-2 py-1 text-xs text-muted-foreground">
      {!document && !failed && <Loader2 aria-hidden className="h-3 w-3 animate-spin" />}
      <button type="button" aria-label={t('messages.copyMarkdown')} title={t('messages.copyMarkdown')}
        className="rounded p-1 hover:bg-muted" data-markdown-copy onClick={async () => {
          if (await copyText(text)) {
            setCopied(true);
            if (copyTimer.current) clearTimeout(copyTimer.current);
            copyTimer.current = setTimeout(() => { copyTimer.current = null; setCopied(false); }, 1500);
          }
        }}>{copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}</button>
    </div>
    {failed ? <textarea aria-label={t('messages.markdownDocument')} readOnly value={text}
      className="h-80 w-full resize-y bg-transparent p-2 font-mono text-xs" />
      : <div ref={viewport} data-markdown-viewport role="region" aria-label={t('messages.markdownDocument')} tabIndex={0}
        aria-busy={!document} style={{ height: document ? Math.min(480, Math.max(96, rows.length * 64)) : 320,
          overflow: 'auto', contain: 'layout style', overscrollBehavior: 'contain' }}
        onClick={event => {
          const link = (event.target as HTMLElement).closest('a');
          const href = link?.getAttribute('href');
          if (!document || !href?.startsWith('#')) return;
          let anchor: string;
          try { anchor = decodeURIComponent(href.slice(1)); } catch { return; }
          if (!Object.hasOwn(document.anchors, anchor)) return;
          const index = document.anchors[anchor];
          event.preventDefault();
          virtualizer.scrollToIndex(index, { align: 'start' });
        }}>
        {document ? <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map(item => <div key={item.key} data-index={item.index}
            data-transcript-row-key={rowKeys[item.index].key}
            ref={virtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%',
              transform: `translateY(${item.start}px)` }}>
            <MarkdownRow node={rows[item.index]} renderNode={renderNode} />
          </div>)}
        </div> : preview}
      </div>}
  </div>;
}

const MarkdownRow = memo(function MarkdownRow({ node, renderNode }: {
  node: RootContent; renderNode: Props['renderNode'];
}) { return renderNode(node); });
