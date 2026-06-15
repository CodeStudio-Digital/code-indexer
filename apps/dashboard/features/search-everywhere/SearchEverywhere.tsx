/**
 * Search Everywhere (Shift Shift) — IntelliJ's hub, five tabs:
 *   All | Files | Symbols | Text | Commands      (Tab cycles)
 * Files rank client-side over files.list (cached per open, recents-first
 * on empty query); Symbols/Text hit the thin FTS endpoints; Commands come
 * from the registry. Enter opens / runs; symbols reveal line:col.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Braces, FileCode2, History, SquareTerminal, Text } from 'lucide-react';
import { apiCall } from '../../lib/api-client.js';
import { rankPath } from '../../lib/fuzzy.js';
import { fileIconFor } from '../../lib/file-icon.js';
import { cn } from '../../lib/utils.js';
import { listCommands, executeCommand } from '../../keymap/commands.js';
import { bindingLabel } from '../../keymap/keymap-store.js';
import { recentFiles } from '../../state/recent-files.js';
import { getActiveEditor } from '../workspace/editor/editor-models.js';
import { useSeStore, type SeTab } from './se-store.js';

interface SymbolHitDTO {
  name: string; kind: string; file_path: string;
  line: number | null; col: number | null; signature: string; exported: number;
}

type Item =
  | { kind: 'file'; path: string }
  | { kind: 'recent'; path: string }
  | { kind: 'symbol'; hit: SymbolHitDTO }
  | { kind: 'text'; path: string }
  | { kind: 'command'; id: string; title: string; category: string };

const TABS: Array<{ id: SeTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'files', label: 'Files' },
  { id: 'symbols', label: 'Symbols' },
  { id: 'text', label: 'Text' },
  { id: 'commands', label: 'Commands' },
];

export function SearchEverywhere({ projectId, onOpenFile }: { projectId: number; onOpenFile: (path: string) => void }) {
  const { open, tab, close, setTab } = useSeStore();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [highlight, setHighlight] = useState(0);
  const allPaths = useRef<string[] | null>(null);
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHighlight(0);
    allPaths.current = null;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const compute = useCallback(async (q: string, activeTab: SeTab): Promise<Item[]> => {
    const trimmed = q.trim();
    const wantFiles = activeTab === 'all' || activeTab === 'files';
    const wantSymbols = (activeTab === 'all' || activeTab === 'symbols') && trimmed.length >= 2;
    const wantText = activeTab === 'text' && trimmed.length >= 3;
    const wantCommands = activeTab === 'all' || activeTab === 'commands';

    const out: Item[] = [];
    if (!trimmed && wantFiles) {
      out.push(...recentFiles(projectId).slice(0, 15).map<Item>((path) => ({ kind: 'recent', path })));
    }
    if (wantCommands) {
      const q2 = trimmed.toLowerCase();
      const cmds = listCommands()
        .filter((c) => !q2 || `${c.category} ${c.title}`.toLowerCase().includes(q2))
        .slice(0, activeTab === 'commands' ? 50 : 5)
        .map<Item>((c) => ({ kind: 'command', id: c.id, title: c.title, category: c.category }));
      if (activeTab === 'commands') out.push(...cmds);
      else if (trimmed) out.push(...cmds);
    }
    if (wantFiles && trimmed) {
      if (!allPaths.current) {
        allPaths.current = await apiCall<Array<{ path: string }>>('files.list', { projectId })
          .then((rows) => rows.map((r) => r.path))
          .catch(() => []);
      }
      const ranked = allPaths.current
        .map((path) => ({ path, score: rankPath(path, trimmed) }))
        .filter((x): x is { path: string; score: number } => x.score !== null)
        .sort((a, b) => a.score - b.score)
        .slice(0, activeTab === 'files' ? 50 : 10);
      out.push(...ranked.map<Item>((r) => ({ kind: 'file', path: r.path })));
    }
    if (wantSymbols) {
      const hits = await apiCall<SymbolHitDTO[]>('search.symbols', {
        projectId, query: trimmed, limit: activeTab === 'symbols' ? 50 : 10,
      }).catch(() => []);
      out.push(...hits.map<Item>((hit) => ({ kind: 'symbol', hit })));
    }
    if (wantText) {
      const hits = await apiCall<Array<{ path: string }>>('search.text', {
        projectId, query: trimmed, limit: 50,
      }).catch(() => []);
      out.push(...hits.map<Item>((h) => ({ kind: 'text', path: h.path })));
    }
    return out;
  }, [projectId]);

  // Debounced recompute (120ms) with stale-result discard.
  useEffect(() => {
    if (!open) return;
    const mySeq = ++seq.current;
    const timer = setTimeout(() => {
      void compute(query, tab).then((result) => {
        if (seq.current === mySeq) {
          setItems(result);
          setHighlight(0);
        }
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [open, query, tab, compute]);

  const pick = useCallback((item: Item) => {
    close();
    if (item.kind === 'command') {
      executeCommand(item.id);
      return;
    }
    const path = item.kind === 'symbol' ? item.hit.file_path : item.path;
    onOpenFile(path);
    if (item.kind === 'symbol' && item.hit.line) {
      const { line } = item.hit;
      const column = item.hit.col ?? 1;
      // The tab mounts async — give Monaco a beat, then reveal.
      setTimeout(() => {
        const editor = getActiveEditor();
        editor?.revealLineInCenter(line);
        editor?.setPosition({ lineNumber: line, column });
        editor?.focus();
      }, 120);
    }
  }, [close, onOpenFile]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ix = TABS.findIndex((t) => t.id === tab);
      setTab(TABS[(ix + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length].id);
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, items.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    if (e.key === 'Enter' && items[highlight]) { e.preventDefault(); pick(items[highlight]); }
  };

  const rows = useMemo(() => items.slice(0, 60), [items]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className="p-0 gap-0 max-w-xl top-[18%] translate-y-0">
        <div className="flex items-center gap-1 border-b px-2 pt-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'px-2 pb-1.5 text-[11.5px] border-b-2 -mb-px transition-colors',
                tab === t.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
          <span className="ml-auto pr-1 pb-1 text-[10px] text-muted-foreground/70">Tab to switch</span>
        </div>
        <div className="p-2 border-b">
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type to search files, symbols, text and actions…"
            className="h-8 text-[12.5px]"
          />
        </div>
        <div className="max-h-[420px] overflow-y-auto py-1">
          {rows.length === 0 && (
            <div className="px-3 py-3 text-[11.5px] text-muted-foreground">
              {query.trim() ? 'No results.' : 'Recent files appear here — start typing to search.'}
            </div>
          )}
          {rows.map((item, ix) => (
            <SeRow key={`${item.kind}:${ix}`} item={item} active={ix === highlight} onPick={() => pick(item)} onHover={() => setHighlight(ix)} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SeRow({ item, active, onPick, onHover }: { item: Item; active: boolean; onPick: () => void; onHover: () => void }) {
  const base = cn(
    'w-full text-left px-3 py-1 flex items-center gap-2 text-[12px]',
    active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/40',
  );
  if (item.kind === 'command') {
    const cmd = listCommands().find((c) => c.id === item.id);
    return (
      <button type="button" className={base} onClick={onPick} onMouseMove={onHover}>
        <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-violet-400" />
        <span className="truncate">{item.title}</span>
        <span className="text-[10px] text-muted-foreground/70">{item.category}</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">{cmd ? bindingLabel(cmd) : ''}</span>
      </button>
    );
  }
  if (item.kind === 'symbol') {
    const h = item.hit;
    return (
      <button type="button" className={base} onClick={onPick} onMouseMove={onHover}>
        <Braces className="h-3.5 w-3.5 shrink-0 text-sky-400" />
        <span className="truncate">{h.name}</span>
        <span className="text-[10px] text-muted-foreground/70 truncate">{h.kind} · {h.file_path}:{h.line ?? '?'}</span>
      </button>
    );
  }
  const path = item.path;
  const { Icon, colorClass } = fileIconFor(path);
  const Lead = item.kind === 'recent' ? History : item.kind === 'text' ? Text : FileCode2;
  return (
    <button type="button" className={base} onClick={onPick} onMouseMove={onHover}>
      {item.kind === 'file' ? (
        <Icon className={cn('h-3.5 w-3.5 shrink-0', colorClass)} />
      ) : (
        <Lead className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
      )}
      <span className="truncate">{path}</span>
    </button>
  );
}
