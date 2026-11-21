import { memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { observeElementOffset, useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import type { RootContent } from 'hast';
import { CopyMarkdownButton } from './CopyMarkdownButton.js';
import { markdownWorkerQueue } from './markdown-worker-client.js';
import type { MarkdownDocument } from './markdown-document.js';
import { useTranscriptSelection } from './transcript-selection.js';
import { findMarkdownLayout, TranscriptScrollContext } from './transcript-scroll-context.js';

interface Props {
  text: string;
  preview: ReactNode;
  showCopy: boolean;
  initialAnchor?: string;
  scrollWithTranscript?: boolean;
  renderNode: (node: RootContent) => ReactNode;
}

const MAX_MARKDOWN_LAYOUTS = 4;

/** Parse off the UI thread and mount only the paragraphs near the scroll viewport. */
export function LargeMarkdown({ text, preview, renderNode, showCopy, initialAnchor, scrollWithTranscript }: Props) {
  'use no memo'; // TanStack Virtual exposes a mutable instance; do not compiler-memoize it.
  const { t } = useTranslation('chat');
  const transcript = useContext(TranscriptScrollContext);
  const markdownLayouts = scrollWithTranscript ? transcript?.markdownLayouts : undefined;
  const inTranscript = Boolean(markdownLayouts);
  const [layoutKey] = useState(() => Symbol());
  const [initialLayout] = useState(() => markdownLayouts && findMarkdownLayout(markdownLayouts, text));
  const [parsed, setParsed] = useState<{ document: MarkdownDocument; source: string } | null>(initialLayout ?? null);
  const [failed, setFailed] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const lease = useRef<ReturnType<typeof markdownWorkerQueue.acquire> | null>(null);
  useEffect(() => {
    const subscription = markdownWorkerQueue.acquire(result => {
      if (result.document && result.source !== undefined) { setParsed({ document: result.document, source: result.source }); setFailed(false); }
      else setFailed(true);
    });
    lease.current = subscription;
    return () => { subscription.dispose(); lease.current = null; };
  }, []);
  useEffect(() => { lease.current?.update(text); }, [text]);
  const document = parsed && text.startsWith(parsed.source) ? parsed.document : null;
  const rows = document?.rows ?? [];
  const rowKeys = useMemo(() => document?.rows.map((_, index) => ({ key: `markdown-${index}` })) ?? [], [document]);
  const rangeExtractor = useTranscriptSelection(viewport, rowKeys);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is mutable; this component explicitly opts out of Compiler memoization.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => inTranscript ? viewport.current?.closest<HTMLDivElement>('.chat-transcript') ?? null : viewport.current,
    observeElementOffset: inTranscript ? (instance, updateOffset) => {
      // Attaching a message must start from the transcript's current position.
      if (instance.scrollElement) updateOffset(instance.scrollElement.scrollTop, false);
      return observeElementOffset(instance, updateOffset);
    } : observeElementOffset,
    scrollMargin: inTranscript ? scrollMargin : 0,
    initialMeasurementsCache: initialLayout?.measurements,
    estimateSize: () => 64,
    overscan: 4,
    rangeExtractor,
  });
  const height = virtualizer.getTotalSize();
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = inTranscript ? (item, _delta, instance) => {
    const top = instance.scrollElement?.scrollTop ?? 0;
    return instance.scrollDirection !== 'backward' && item.end <= top && top < scrollMargin + height;
  } : undefined;

  useLayoutEffect(() => {
    if (!markdownLayouts || !document || !parsed) return;
    markdownLayouts.delete(layoutKey);
    markdownLayouts.set(layoutKey, { source: parsed.source, document, height, measurements: virtualizer.takeSnapshot() });
    if (markdownLayouts.size > MAX_MARKDOWN_LAYOUTS) markdownLayouts.delete(markdownLayouts.keys().next().value!);
  }, [markdownLayouts, document, parsed, layoutKey, height, virtualizer]);

  useLayoutEffect(() => {
    const content = viewport.current;
    const scroll = inTranscript ? content?.closest<HTMLDivElement>('.chat-transcript') : null;
    const row = content?.closest('[data-transcript-row-key]');
    if (!content || !scroll || !row) return;
    const measure = () => {
      const top = content.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - scroll.clientTop;
      setScrollMargin(Math.round(top));
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(scroll);
    resize.observe(row);
    // Earlier transcript rows can move this row by changing its transform.
    const position = new MutationObserver(measure);
    position.observe(row, { attributes: true, attributeFilter: ['style'] });
    return () => { resize.disconnect(); position.disconnect(); };
  }, [inTranscript]);

  useEffect(() => {
    if (initialAnchor && document && Object.hasOwn(document.anchors, initialAnchor)) {
      if (inTranscript) transcript?.disengage();
      virtualizer.scrollToIndex(document.anchors[initialAnchor], { align: 'start' });
    }
  }, [document, initialAnchor, virtualizer, inTranscript, transcript]);

  return <div data-large-markdown data-markdown-ready={Boolean(document)} className="relative">
    {failed && !inTranscript ? <textarea aria-label={t('messages.markdownDocument')} readOnly value={text}
      className="h-80 w-full resize-y bg-transparent p-2 font-mono text-xs" />
      : <div ref={viewport} data-markdown-viewport={inTranscript ? 'transcript' : ''} role="region" aria-label={t('messages.markdownDocument')} tabIndex={0}
        aria-busy={!document && !failed} style={inTranscript ? { contain: 'layout style' }
          : { height: document ? Math.min(480, Math.max(96, rows.length * 64)) : 320,
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
          if (inTranscript) transcript?.disengage();
          virtualizer.scrollToIndex(index, { align: 'start' });
        }}>
        {failed ? <pre className="whitespace-pre-wrap break-words">{text}</pre>
        : document ? <div style={{ height, position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map(item => <div key={item.key} data-index={item.index}
            data-transcript-row-key={rowKeys[item.index].key}
            ref={virtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%',
              transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)` }}>
            <MarkdownRow node={rows[item.index]} renderNode={renderNode} />
          </div>)}
        </div> : preview}
    </div>}
    {(showCopy || (!document && !failed)) && <div className="not-prose flex items-center justify-end gap-2 py-1 text-muted-foreground">
      {!document && !failed && <Loader2 aria-hidden className="h-3 w-3 animate-spin" />}
      {showCopy && <CopyMarkdownButton text={text} />}
    </div>}
  </div>;
}

const MarkdownRow = memo(function MarkdownRow({ node, renderNode }: {
  node: RootContent; renderNode: Props['renderNode'];
}) { return renderNode(node); });
