/**
 * Streaming ("live") render blocks, split out of `renderStreamBlock` so they
 * can hold hooks and be memoized. The live turn re-renders on every rAF flush;
 * memoizing these keeps blocks whose text didn't change this frame from
 * re-rendering, and `useDeferredValue` stops react-markdown from re-parsing the
 * whole accumulator on every frame of a fast stream.
 */
import { memo, useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { useThrottledValue } from '../../../hooks/useThrottledValue.js';
import { Markdown } from './Markdown.js';
import { cleanThinkingMarkdown } from './thinking-text.js';

/**
 * How often a live block re-parses its markdown. Two stages guard the parse:
 *
 *  - `useThrottledValue` bounds HOW MUCH work happens — react-markdown re-parses
 *    the whole accumulator on every call, so at ~60 flushes/s a long answer was
 *    re-parsed 60×/s. This caps that at ~12×/s.
 *  - `useDeferredValue` lowers the render's priority so input can run first.
 *    The markdown parser and syntax tokenizer are still synchronous once
 *    entered; long documents use a worker parser and a bounded reading viewport.
 *
 * 80 ms is under the ~100 ms threshold where UI stops feeling instantaneous, and
 * the trailing commit means the settled text is identical to the unthrottled
 * render — only intermediate frames are skipped.
 */
const LIVE_MARKDOWN_INTERVAL_MS = 80;

/**
 * Live markdown. The final text the user keeps is the persisted (non-deferred)
 * history render; this only ever lags the transient live bubble by a frame or
 * two, and snaps current when the stream pauses.
 */
export const LiveTextBlock = memo(function LiveTextBlock({ text }: { text: string }) {
  const throttled = useThrottledValue(text, LIVE_MARKDOWN_INTERVAL_MS);
  const deferred = useDeferredValue(throttled);
  return (
    <div className="text-[13px] leading-5 text-foreground/90">
      <Markdown text={deferred} />
    </div>
  );
});

/**
 * Collapsible streaming "thinking" block. Memoized so that when another block
 * in the live turn updates, a thinking block whose `text` is unchanged this
 * frame doesn't re-render; and when collapsed, only the cheap header reconciles.
 */
export const LiveThinkingBlock = memo(function LiveThinkingBlock({ text }: { text: string }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  // Same throttle as the answer text: reasoning traces stream just as fast and
  // `cleanThinkingMarkdown` walks the whole accumulator before the parse even
  // starts. Collapsed blocks skip both — only the cheap header reconciles.
  const throttled = useThrottledValue(text, LIVE_MARKDOWN_INTERVAL_MS);
  const deferred = useDeferredValue(throttled);
  const displayText = open ? cleanThinkingMarkdown(deferred) : '';
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <Brain className="h-3 w-3 animate-pulse" />
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="font-medium">{t('messages.thinking')}</span>
      </button>
      {open && (
        <div className="ml-4 max-h-[32vh] overflow-y-auto border-l border-border/60 py-1 pl-3">
          <Markdown
            text={displayText}
            className="text-[11px] leading-[1.15rem] text-muted-foreground italic prose-p:my-1 prose-strong:text-muted-foreground prose-code:text-muted-foreground"
          />
        </div>
      )}
    </div>
  );
});
