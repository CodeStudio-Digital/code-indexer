/**
 * Command palette — Ctrl/Cmd+Shift+P. Lists every registered command,
 * fuzzy-filterable, runnable by Enter or click. Same modal chrome as
 * Quick Open so the user only learns the layout once.
 *
 * Commands are passed in by the Workspace (which knows the live
 * layout-toggle callbacks). Each carries an optional keyboard shortcut
 * label that we render on the right — matches the "what can I press?"
 * affordance the user already expects from VS Code / IntelliJ.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Dialog, DialogContent } from '../../../components/ui/dialog.js';
import { Input } from '../../../components/ui/input.js';
import { cn } from '../../../lib/utils.js';

export interface Command {
  id: string;
  label: string;
  category?: string;
  shortcut?: string;
  icon?: React.ComponentType<{ className?: string }>;
  run: () => void | Promise<void>;
}

interface CommandPaletteProps {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}

function rank(label: string, q: string): number | null {
  if (!q) return label.length;
  const lower = label.toLowerCase();
  const qLower = q.toLowerCase();
  const ix = lower.indexOf(qLower);
  if (ix >= 0) return ix * 2 + label.length;
  // Subsequence fallback so "tt" finds "Toggle Terminal".
  let li = 0;
  let qi = 0;
  while (li < lower.length && qi < qLower.length) {
    if (lower[li] === qLower[qi]) qi += 1;
    li += 1;
  }
  if (qi < qLower.length) return null;
  return 100_000 + label.length;
}

export function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHighlight(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const results = useMemo(() => {
    const scored: Array<{ cmd: Command; score: number }> = [];
    for (const c of commands) {
      const haystack = c.category ? `${c.category} ${c.label}` : c.label;
      const s = rank(haystack, query);
      if (s !== null) scored.push({ cmd: c, score: s });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, 30).map((r) => r.cmd);
  }, [commands, query]);

  useEffect(() => {
    if (highlight >= results.length) setHighlight(0);
  }, [results, highlight]);

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-cmd-index="${highlight}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const choose = useCallback(
    (cmd: Command) => {
      onClose();
      void cmd.run();
    },
    [onClose],
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
        if (pick) choose(pick);
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
            placeholder="Type a command…"
            className="h-8 text-[13px]"
          />
        </div>
        <div ref={listRef} className="max-h-[360px] overflow-y-auto">
          {results.length === 0 && (
            <div className="px-3 py-4 text-[11.5px] text-muted-foreground text-center">
              {query ? `No commands matching "${query}"` : 'No commands registered.'}
            </div>
          )}
          {results.map((c, i) => {
            const Icon = c.icon;
            const active = i === highlight;
            return (
              <button
                key={c.id}
                type="button"
                data-cmd-index={i}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(c)}
                className={cn(
                  'group w-full text-left px-3 py-1.5 flex items-center gap-2 transition-colors',
                  active
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {Icon ? (
                  <Icon className="h-3 w-3 shrink-0 text-muted-foreground/70" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40" />
                )}
                {c.category && (
                  <span className="text-[10.5px] text-muted-foreground/70 shrink-0">
                    {c.category}:
                  </span>
                )}
                <span className="text-[12px] truncate flex-1 text-foreground">{c.label}</span>
                {c.shortcut && (
                  <span className="text-[10px] text-muted-foreground/70 font-mono">
                    {c.shortcut}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="px-3 py-1.5 border-t bg-card/50 flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>
            <kbd className="font-mono">↑</kbd> <kbd className="font-mono">↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-mono">Enter</kbd> run
          </span>
          <span>
            <kbd className="font-mono">Esc</kbd> close
          </span>
          <span className="ml-auto">{results.length} of {commands.length}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
