import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '../../lib/utils.js';
import { ensureLang, getHighlighter, type ShikiTheme } from '../builder/preview/files/viewer/shiki-client.js';
import { langFromPath } from '../builder/preview/files/viewer/language.js';
import { useIsDark } from '../builder/preview/files/viewer/useIsDark.js';
import { buildCommitDiffRows, type CommitDiffRow } from './commit-file-diff.js';

type SyntaxToken = { content: string; color?: string };

const MAX_HIGHLIGHT_BYTES = 250_000;
const MAX_HIGHLIGHT_LINES = 4_000;

export function CommitFileDiff({ patch, path, truncated }: { patch: string; path: string; truncated: boolean }) {
  const { t } = useTranslation('workspace');
  const dark = useIsDark();
  const theme: ShikiTheme = dark ? 'github-dark' : 'github-light';
  const rows = useMemo(() => buildCommitDiffRows(patch), [patch]);
  const codeRows = useMemo(() => rows.filter((row) => row.kind === 'line'), [rows]);
  const [tokens, setTokens] = useState<SyntaxToken[][] | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [patch]);

  useEffect(() => {
    setTokens(null);
    if (patch.length > MAX_HIGHLIGHT_BYTES || codeRows.length > MAX_HIGHLIGHT_LINES || codeRows.length === 0) return;
    let active = true;
    void (async () => {
      const lang = await ensureLang(langFromPath(path));
      const highlighter = await getHighlighter();
      const highlighted = highlighter.codeToTokensBase(
        codeRows.map((row) => row.content).join('\n'),
        { lang, theme },
      );
      if (active) setTokens(highlighted);
    })().catch(() => { /* plain colored diff remains available */ });
    return () => { active = false; };
  }, [codeRows, patch.length, path, theme]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 20,
    overscan: 20,
    getItemKey: (index) => rows[index]?.key ?? index,
  });
  const maxChars = useMemo(
    () => rows.reduce((max, row) => Math.max(max, row.content.length), 0),
    [rows],
  );
  const width = Math.min(20_000, Math.max(720, maxChars * 7.2 + 116));

  if (!patch.trim() || rows.length === 0) {
    return <div className="grid h-full place-items-center px-4 text-center text-[10.5px] text-muted-foreground">{t('git.pushReview.emptyDiff')}</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {truncated && <div className="shrink-0 border-b bg-amber-500/10 px-3 py-1.5 text-[10px] text-amber-500">{t('git.pushReview.diffTruncated')}</div>}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div
          className="relative min-h-full font-mono text-[10.5px] leading-5"
          style={{ height: virtualizer.getTotalSize(), width, minWidth: '100%' }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]!;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <CommitDiffRowView row={row} tokens={tokens} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CommitDiffRowView({ row, tokens }: { row: CommitDiffRow; tokens: SyntaxToken[][] | null }) {
  if (row.kind === 'hunk') {
    return <div className="border-y border-sky-500/15 bg-sky-500/10 px-3 text-sky-700 dark:text-sky-300">{row.content}</div>;
  }
  if (row.kind === 'meta') {
    return <div className="px-3 italic text-muted-foreground">{row.content}</div>;
  }
  const prefix = row.type === 'insert' ? '+' : row.type === 'delete' ? '-' : ' ';
  return (
    <div className={cn(
      'flex min-w-full whitespace-pre',
      row.type === 'insert' && 'bg-emerald-500/10 dark:bg-emerald-500/15',
      row.type === 'delete' && 'bg-rose-500/10 dark:bg-rose-500/15',
    )}>
      <span className="w-11 shrink-0 select-none border-r px-1.5 text-right tabular-nums text-muted-foreground/60">{row.oldLine ?? ''}</span>
      <span className="w-11 shrink-0 select-none border-r px-1.5 text-right tabular-nums text-muted-foreground/60">{row.newLine ?? ''}</span>
      <span className={cn(
        'w-5 shrink-0 select-none text-center',
        row.type === 'insert' && 'text-emerald-600 dark:text-emerald-400',
        row.type === 'delete' && 'text-rose-600 dark:text-rose-400',
        row.type === 'normal' && 'text-muted-foreground/50',
      )}>{prefix}</span>
      <code className="pr-8">
        {tokens?.[row.tokenIndex]?.map((token, index) => (
          <span key={index} style={token.color ? { color: token.color } : undefined}>{token.content}</span>
        )) ?? (row.content || ' ')}
      </code>
    </div>
  );
}
