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
import { Markdown } from './Markdown.js';

/**
 * Live markdown. `useDeferredValue` lets React keep the previous parse on
 * screen while a newer one renders in the background, so a 50-token/s stream
 * doesn't re-run remark-gfm every frame. The final text the user keeps is the
 * persisted (non-deferred) history render — this only ever lags the transient
 * live bubble by a frame or two, and snaps current when the stream pauses.
 */
export const LiveTextBlock = memo(function LiveTextBlock({ text }: { text: string }) {
  const deferred = useDeferredValue(text);
  return (
    <div className="text-sm text-foreground/90">
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
  const [open, setOpen] = useState(true);
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <Brain className="h-3.5 w-3.5 animate-pulse" />
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="font-medium">{t('messages.thinking')}</span>
      </button>
      {open && (
        <div className="mt-1 ml-5 rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground italic whitespace-pre-wrap max-h-[40vh] overflow-y-auto">
          {text}
        </div>
      )}
    </div>
  );
});
