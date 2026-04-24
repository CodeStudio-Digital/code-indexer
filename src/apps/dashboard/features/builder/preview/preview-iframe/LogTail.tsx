import React, { useRef } from 'react';

interface Props {
  lines: Array<{ at: number; level: 'info' | 'error'; text: string }>;
}

/**
 * Scrollable tail of recent sandbox log lines. Auto-scrolls to bottom on
 * new content, but only when the user is already near the bottom — avoids
 * hijacking their scroll if they're reading earlier output.
 */
export function LogTail({ lines }: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <div
      ref={scrollerRef}
      className="flex-1 min-h-[8rem] overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[10.5px] leading-snug"
    >
      {lines.length === 0 ? (
        <div className="text-muted-foreground italic">waiting for output…</div>
      ) : (
        lines.map((l, i) => (
          <div key={`${l.at}-${i}`} className={l.level === 'error' ? 'text-destructive' : ''}>
            {l.text}
          </div>
        ))
      )}
    </div>
  );
}
