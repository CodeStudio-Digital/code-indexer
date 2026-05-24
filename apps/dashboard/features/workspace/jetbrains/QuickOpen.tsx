/**
 * Quick Open dialog — Ctrl/Cmd+P. Lists every indexed file in the
 * active project, fuzzy-filters by substring, opens the chosen one
 * in the editor.
 *
 * Backed by `files.list` (DB-indexed paths) rather than `files.tree`
 * so deeply-nested files outside the tree's maxDepth still show up.
 * Keyboard: ↑/↓ to navigate, Enter to open, Esc to close. Mouse-
 * click also works.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import { Dialog, DialogContent } from '../../../components/ui/dialog.js';
import { Input } from '../../../components/ui/input.js';
import { apiCall } from '../../../lib/api-client.js';
import { cn } from '../../../lib/utils.js';

interface QuickOpenProps {
  projectId: number;
  open: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
}

interface IndexedFile {
  id: number;
  path: string;
  language?: string;
}

const MAX_RESULTS = 50;

/**
 * Tiny ranking: prefer matches at the basename start, then any
 * basename hit, then any path hit. Penalty for length keeps short
 * matches above long ones. Good enough at this scale; swap for
 * fzy/fzf-style later if a project crosses 50k files.
 */
function rankPath(path: string, q: string): number | null {
  if (!q) return path.length;
  const lower = path.toLowerCase();
  const qLower = q.toLowerCase();
  const ix = lower.indexOf(qLower);
  if (ix < 0) {
    // Fallback: character-by-character subsequence so users can type
    // initials (e.g. "wstx" → "Workspace.tsx").
    let li = 0;
    let qi = 0;
    while (li < lower.length && qi < qLower.length) {
      if (lower[li] === qLower[qi]) qi += 1;
      li += 1;
    }
    if (qi < qLower.length) return null;
    return 100_000 + path.length;
  }
  const slashIx = lower.lastIndexOf('/', ix);
  const basenameMatch = ix === slashIx + 1;
  let score = ix * 2 + path.length;
  if (basenameMatch) score -= 1000;
  return score;
}

export function QuickOpen({ projectId, open, onClose, onPick }: QuickOpenProps) {
  const [files, setFiles] = useState<IndexedFile[]>([]);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset on open and focus the input.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHighlight(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Load indexed files once per open. Cheap (single SELECT) so we don't
  // bother memoising across opens — keeps the list fresh after the user
  // creates files via the file tree or the agent.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    apiCall<IndexedFile[]>('files.list', { projectId })
      .then((list) => {
        if (cancelled) return;
        setFiles(list ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const results = useMemo(() => {
    const out: Array<{ file: IndexedFile; score: number }> = [];
    for (const f of files) {
      const s = rankPath(f.path, query);
      if (s !== null) out.push({ file: f, score: s });
    }
    out.sort((a, b) => a.score - b.score);
    return out.slice(0, MAX_RESULTS).map((r) => r.file);
  }, [files, query]);

  // Keep highlight valid.
  useEffect(() => {
    if (highlight >= results.length) setHighlight(0);
  }, [results, highlight]);

  // Scroll highlighted row into view.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-qo-index="${highlight}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const choose = useCallback(
    (path: string) => {
      onPick(path);
      onClose();
    },
    [onPick, onClose],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => Math.min(results.length - 1, h + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => Math.max(0, h - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = results[highlight];
        if (pick) choose(pick.path);
      }
    },
    [results, highlight, choose],
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="p-0 gap-0 max-w-[640px] overflow-hidden"
        onKeyDown={onKeyDown}
      >
        <div className="p-2 border-b">
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Go to file…"
            className="h-8 text-[13px]"
          />
        </div>
        <div ref={listRef} className="max-h-[360px] overflow-y-auto">
          {results.length === 0 && (
            <div className="px-3 py-4 text-[11.5px] text-muted-foreground text-center">
              {query ? `No files matching "${query}"` : 'No indexed files in this project.'}
            </div>
          )}
          {results.map((f, i) => (
            <button
              key={f.path}
              type="button"
              data-qo-index={i}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => choose(f.path)}
              className={cn(
                'group w-full text-left px-3 py-1.5 flex items-center gap-2 transition-colors',
                i === highlight
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <FileCode2 className="h-3 w-3 shrink-0 text-muted-foreground/70" />
              <span className="text-[12px] truncate font-medium text-foreground">
                {basename(f.path)}
              </span>
              <span className="text-[10.5px] truncate ml-auto text-muted-foreground/70 font-mono">
                {dirname(f.path)}
              </span>
            </button>
          ))}
        </div>
        <div className="px-3 py-1.5 border-t bg-card/50 flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>
            <kbd className="font-mono">↑</kbd> <kbd className="font-mono">↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-mono">Enter</kbd> open
          </span>
          <span>
            <kbd className="font-mono">Esc</kbd> close
          </span>
          <span className="ml-auto">{results.length} of {files.length}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function basename(p: string): string {
  const ix = p.lastIndexOf('/');
  return ix < 0 ? p : p.slice(ix + 1);
}

function dirname(p: string): string {
  const ix = p.lastIndexOf('/');
  return ix <= 0 ? '' : p.slice(0, ix);
}
