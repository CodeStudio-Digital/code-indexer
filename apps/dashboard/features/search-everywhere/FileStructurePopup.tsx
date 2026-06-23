/**
 * File Structure (Ctrl+F12) — symbols of the ACTIVE file from the
 * structural index, fuzzy-filtered locally; Enter reveals line:col.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Braces } from 'lucide-react';
import { Dialog, DialogContent } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { apiCall } from '../../lib/api-client.js';
import { rankPath } from '../../lib/fuzzy.js';
import { cn } from '../../lib/utils.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { getActiveEditor } from '../workspace/editor/editor-models.js';
import { useSeStore } from './se-store.js';

interface SymbolDTO {
  name: string; kind: string; line: number | null; col: number | null;
  parent: string | null; signature: string;
}

export function FileStructurePopup({ projectId }: { projectId: number }) {
  const open = useSeStore((s) => s.structureOpen);
  const setOpen = useSeStore((s) => s.setStructureOpen);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const [symbols, setSymbols] = useState<SymbolDTO[]>([]);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || !activeFilePath) return;
    setQuery('');
    setHighlight(0);
    requestAnimationFrame(() => inputRef.current?.focus());
    let cancelled = false;
    void apiCall<{ symbols?: SymbolDTO[] }>('files.get', { projectId, path: activeFilePath })
      .then((res) => { if (!cancelled) setSymbols(res.symbols ?? []); })
      .catch(() => { if (!cancelled) setSymbols([]); });
    return () => { cancelled = true; };
  }, [open, projectId, activeFilePath]);

  const rows = useMemo(() => {
    const q = query.trim();
    return symbols
      .map((s) => ({ s, score: rankPath(`${s.parent ? `${s.parent}.` : ''}${s.name}`, q) }))
      .filter((x): x is { s: SymbolDTO; score: number } => x.score !== null)
      .sort((a, b) => (q ? a.score - b.score : (a.s.line ?? 0) - (b.s.line ?? 0)))
      .slice(0, 200)
      .map((x) => x.s);
  }, [symbols, query]);

  const reveal = (s: SymbolDTO) => {
    setOpen(false);
    if (!s.line) return;
    const editor = getActiveEditor();
    editor?.revealLineInCenter(s.line);
    editor?.setPosition({ lineNumber: s.line, column: s.col ?? 1 });
    editor?.focus();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="p-0 gap-0 max-w-lg top-[18%] translate-y-0">
        <div className="p-2 border-b">
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, rows.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
              if (e.key === 'Enter' && rows[highlight]) { e.preventDefault(); reveal(rows[highlight]); }
            }}
            placeholder={activeFilePath ? `Structure of ${activeFilePath.split('/').pop()}` : 'No active file'}
            className="h-8 text-[12.5px]"
          />
        </div>
        <div className="max-h-[400px] overflow-y-auto py-1">
          {rows.length === 0 && (
            <div className="px-3 py-3 text-[11.5px] text-muted-foreground">No symbols (file not indexed yet?).</div>
          )}
          {rows.map((s, ix) => (
            <button
              key={`${s.name}:${s.line}:${ix}`}
              type="button"
              onClick={() => reveal(s)}
              onMouseMove={() => setHighlight(ix)}
              className={cn(
                'w-full text-left px-3 py-1 flex items-center gap-2 text-[12px]',
                ix === highlight ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/40',
              )}
            >
              <Braces className="h-3.5 w-3.5 shrink-0 text-sky-400" />
              <span className="truncate">{s.parent ? `${s.parent}.` : ''}{s.name}</span>
              <span className="ml-auto text-[10px] text-muted-foreground/70">{s.kind} · :{s.line ?? '?'}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
