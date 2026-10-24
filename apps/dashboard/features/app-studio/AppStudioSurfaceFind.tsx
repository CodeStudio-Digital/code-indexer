import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CaseSensitive, ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { cn } from '../../lib/utils.js';

const MATCH_HIGHLIGHT = 'app-studio-find-match';
const ACTIVE_HIGHLIGHT = 'app-studio-find-active';
const MAX_MATCHES = 500;

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

type HighlightConstructor = new (...ranges: Range[]) => unknown;

function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightConstructor } | null {
  const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  const Highlight = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

function clearHighlights(): void {
  const api = highlightApi();
  api?.registry.delete(MATCH_HIGHLIGHT);
  api?.registry.delete(ACTIVE_HIGHLIGHT);
}

function paintHighlights(ranges: Range[], activeIndex: number): void {
  const api = highlightApi();
  if (!api) return;
  api.registry.delete(MATCH_HIGHLIGHT);
  api.registry.delete(ACTIVE_HIGHLIGHT);
  if (ranges.length === 0) return;
  api.registry.set(MATCH_HIGHLIGHT, new api.Highlight(...ranges));
  const active = ranges[activeIndex];
  if (active) api.registry.set(ACTIVE_HIGHLIGHT, new api.Highlight(active));
}

function searchableTextNode(node: Node, root: HTMLElement): boolean {
  const parent = node.parentElement;
  if (!parent || !root.contains(parent)) return false;
  if (parent.closest('[data-app-studio-find-ui], script, style, noscript, [aria-hidden="true"]')) return false;
  const style = window.getComputedStyle(parent);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

export function findTextMatchOffsets(value: string, rawQuery: string, matchCase: boolean): number[] {
  const query = rawQuery.trim();
  if (!query) return [];
  const haystack = matchCase ? value : value.toLocaleLowerCase();
  const needle = matchCase ? query : query.toLocaleLowerCase();
  const offsets: number[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    offsets.push(index);
    from = index + Math.max(needle.length, 1);
  }
  return offsets;
}

function findSurfaceTextRanges(root: HTMLElement, rawQuery: string, matchCase: boolean): Range[] {
  const query = rawQuery.trim();
  if (!query) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && ranges.length < MAX_MATCHES) {
    if (searchableTextNode(node, root)) {
      const value = node.nodeValue ?? '';
      for (const index of findTextMatchOffsets(value, query, matchCase)) {
        if (ranges.length >= MAX_MATCHES) break;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + query.length);
        ranges.push(range);
      }
    }
    node = walker.nextNode();
  }
  return ranges;
}

function scrollToRange(range: Range | undefined): void {
  const element = range?.startContainer.parentElement;
  element?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
}

export function AppStudioSurfaceFind({ children }: { children: ReactNode }) {
  const { t } = useTranslation('appStudio');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [matchVersion, setMatchVersion] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);

  const recompute = useCallback(() => {
    const root = rootRef.current;
    const ranges = root && open ? findSurfaceTextRanges(root, query, matchCase) : [];
    rangesRef.current = ranges;
    setMatchCount(ranges.length);
    setMatchVersion((version) => version + 1);
    setActiveIndex((current) => ranges.length === 0 ? 0 : Math.min(current, ranges.length - 1));
  }, [matchCase, open, query]);

  const move = useCallback((delta: number) => {
    if (rangesRef.current.length === 0) return;
    setActiveIndex((current) => (current + delta + rangesRef.current.length) % rangesRef.current.length);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    clearHighlights();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLocaleLowerCase() === 'f') {
        const active = document.activeElement;
        const root = rootRef.current;
        const editingOutsideSurface = active instanceof HTMLElement &&
          !root?.contains(active) &&
          (active.matches('input, textarea, select') || active.isContentEditable);
        if (editingOutsideSurface) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      } else if (event.key === 'F3' && open) {
        event.preventDefault();
        move(event.shiftKey ? -1 : 1);
      } else if (event.key === 'Escape' && open) {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [close, move, open]);

  useLayoutEffect(() => {
    recompute();
  }, [recompute, children]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !open) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(recompute, 80);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [open, recompute]);

  useEffect(() => {
    if (!open) return;
    paintHighlights(rangesRef.current, activeIndex);
    scrollToRange(rangesRef.current[activeIndex]);
  }, [activeIndex, matchCount, matchVersion, open]);

  useEffect(() => () => clearHighlights(), []);

  return (
    <div ref={rootRef} className="relative h-full min-h-0">
      <style>{`
        ::highlight(${MATCH_HIGHLIGHT}) {
          background-color: color-mix(in srgb, var(--warning) 42%, transparent);
          color: inherit;
        }
        ::highlight(${ACTIVE_HIGHLIGHT}) {
          background-color: color-mix(in srgb, var(--primary) 72%, transparent);
          color: var(--primary-foreground);
        }
      `}</style>
      {open && (
        <div
          data-app-studio-find-ui
          className="absolute right-3 top-3 z-40 flex h-9 items-center gap-1 rounded-md border bg-background px-1.5 shadow-lg"
          role="search"
          aria-label={t('surfaceFind.title')}
        >
          <Search className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                move(event.shiftKey ? -1 : 1);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                close();
              }
            }}
            className="h-7 w-56 border-0 px-1 text-xs shadow-none focus-visible:ring-0"
            placeholder={t('surfaceFind.placeholder')}
            aria-label={t('surfaceFind.placeholder')}
          />
          <span className="min-w-14 text-center text-[11px] tabular-nums text-muted-foreground">
            {matchCount > 0 ? `${activeIndex + 1}/${matchCount}` : t('surfaceFind.noResults')}
          </span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn('h-7 w-7', matchCase && 'bg-accent text-accent-foreground')}
            onClick={() => setMatchCase((value) => !value)}
            aria-pressed={matchCase}
            aria-label={t('surfaceFind.matchCase')}
            title={t('surfaceFind.matchCase')}
          >
            <CaseSensitive className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" size="icon" variant="ghost" className="h-7 w-7" disabled={!matchCount} onClick={() => move(-1)} aria-label={t('surfaceFind.previous')} title={t('surfaceFind.previous')}>
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" size="icon" variant="ghost" className="h-7 w-7" disabled={!matchCount} onClick={() => move(1)} aria-label={t('surfaceFind.next')} title={t('surfaceFind.next')}>
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={close} aria-label={t('surfaceFind.close')} title={t('surfaceFind.close')}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      <div className="h-full min-h-0">{children}</div>
    </div>
  );
}
