/**
 * Search Everywhere (Shift Shift) — IntelliJ's hub, five tabs:
 *   All | Files | Symbols | Text | Commands      (Tab cycles)
 * Files use a bounded path-only query (recents-first
 * on empty query); Symbols/Text hit the thin FTS endpoints; Commands come
 * from the registry. Enter opens / runs; symbols reveal line:col.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Braces, FileCode2, History, Sparkles, SquareTerminal, Text } from 'lucide-react';
import { apiCall } from '../../lib/api-client.js';
import { FileIcon } from '../../components/FileIcon.js';
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

interface SemanticHitDTO {
  id: number;
  type: 'file' | 'symbol';
  score: number;
  fts_rank: number | null;
  vector_score: number | null;
  data: {
    path?: string;
    file_path?: string;
    name?: string;
    kind?: string;
    line?: number | null;
    col?: number | null;
  };
}

type Item =
  | { kind: 'file'; path: string }
  | { kind: 'recent'; path: string }
  | { kind: 'symbol'; hit: SymbolHitDTO }
  | { kind: 'text'; path: string }
  | { kind: 'semantic'; hit: SemanticHitDTO; telemetryRequestId?: string }
  | { kind: 'command'; id: string; title: string; category: string };

interface ComputeResult {
  items: Item[];
  semanticNotice: string | null;
}

export function isNaturalLanguageSearch(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < 3) return false;
  if (/^(?:how|what|where|why|when|which|find|show|explain|como|onde|porque|qual|encontre|mostre)\b/i.test(trimmed)) {
    return true;
  }
  // Paths, qualified names and identifier-like tokens stay on the immediate
  // lexical path. A phrase with whitespace is a useful semantic signal.
  return /\s/.test(trimmed) && !/^[\w$.-]+(?:[\\/:.][\w$.-]+)+$/.test(trimmed);
}

export function searchEverywhereSupersessionKey(projectId: number): string {
  return `search-everywhere:p${projectId}`;
}

function semanticKey(item: Item): string | null {
  if (item.kind === 'file' || item.kind === 'recent' || item.kind === 'text') return `file:${item.path}`;
  if (item.kind === 'symbol') return `symbol:${item.hit.file_path}:${item.hit.name}:${item.hit.line ?? ''}`;
  if (item.kind === 'semantic') {
    const path = item.hit.data.file_path ?? item.hit.data.path ?? '';
    return item.hit.type === 'file'
      ? `file:${path}`
      : `symbol:${path}:${item.hit.data.name ?? ''}:${item.hit.data.line ?? ''}`;
  }
  return null;
}

function mergeSemantic(semantic: Item[], lexical: Item[]): Item[] {
  const seen = new Set(semantic.map(semanticKey).filter((key): key is string => !!key));
  return [...semantic, ...lexical.filter((item) => {
    const key = semanticKey(item);
    if (!key || !seen.has(key)) return true;
    return false;
  })];
}

const TABS: Array<{ id: SeTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'files', label: 'Files' },
  { id: 'symbols', label: 'Symbols' },
  { id: 'text', label: 'Text' },
  { id: 'semantic', label: 'Semantic' },
  { id: 'commands', label: 'Commands' },
];

export function SearchEverywhere({ projectId, onOpenFile }: { projectId: number; onOpenFile: (path: string) => void }) {
  const { t } = useTranslation('search');
  const { open, tab, initialQuery, close, setTab, consumeInitialQuery } = useSeStore();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [semanticNotice, setSemanticNotice] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const lexicalSeq = useRef(0);
  const semanticSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    // A command can close and reopen this dialog inside one React batch. The
    // one-shot seed therefore participates in the effect instead of relying
    // only on an `open: false -> true` render transition.
    if (initialQuery !== null) {
      setQuery(initialQuery);
      consumeInitialQuery();
    } else if (!wasOpen.current) {
      setQuery('');
    }
    wasOpen.current = true;
    setHighlight(0);
    setSemanticNotice(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, initialQuery, consumeInitialQuery]);

  const computeLexical = useCallback(async (
    q: string,
    activeTab: SeTab,
    signal: AbortSignal,
  ): Promise<Item[]> => {
    const trimmed = q.trim();
    const wantFiles = activeTab === 'all' || activeTab === 'files' || activeTab === 'semantic';
    const wantSymbols = (activeTab === 'all' || activeTab === 'symbols' || activeTab === 'semantic') && trimmed.length >= 2;
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
      const ranked = await apiCall<Array<{ path: string }>>('files.searchPaths', {
        projectId, query: trimmed, limit: activeTab === 'files' ? 50 : 10,
      }, { signal }).catch(() => []);
      out.push(...ranked.map<Item>((r) => ({ kind: 'file', path: r.path })));
    }
    if (wantSymbols) {
      const hits = await apiCall<SymbolHitDTO[]>('search.symbols', {
        projectId, query: trimmed, limit: activeTab === 'symbols' ? 50 : 10,
      }, { signal }).catch(() => []);
      out.push(...hits.map<Item>((hit) => ({ kind: 'symbol', hit })));
    }
    if (wantText) {
      const hits = await apiCall<Array<{ path: string }>>('search.text', {
        projectId, query: trimmed, limit: 50,
      }, { signal }).catch(() => []);
      out.push(...hits.map<Item>((h) => ({ kind: 'text', path: h.path })));
    }
    return out;
  }, [projectId]);

  const computeSemantic = useCallback(async (
    q: string,
    signal: AbortSignal,
  ): Promise<ComputeResult> => {
    const response = await apiCall<{
        results: SemanticHitDTO[];
        diagnostics: {
          vectorAvailable?: boolean;
          embeddingAvailable?: boolean;
          vectorError?: string;
          telemetryRequestId?: string;
        };
      }>('search.project', {
        projectId,
        query: q.trim(),
        // The server planner keeps identifiers on FTS and runs the complete
        // vector/RRF/reranker pipeline only for natural-language queries.
        mode: 'auto',
        type: 'all',
        limit: 20,
        supersessionKey: searchEverywhereSupersessionKey(projectId),
        consumer: 'search_everywhere',
      }, { signal }).catch(() => ({ results: [], diagnostics: {
        vectorAvailable: false,
        embeddingAvailable: false,
        vectorError: 'unavailable',
        telemetryRequestId: undefined,
      } }));
    const semanticNotice = (
      response.diagnostics.vectorAvailable === false
      || response.diagnostics.embeddingAvailable === false
      || response.diagnostics.vectorError
    ) ? t('everywhere.semanticFallback') : null;
    return {
      items: response.results.map<Item>((hit) => ({
        kind: 'semantic',
        hit,
        telemetryRequestId: response.diagnostics.telemetryRequestId,
      })),
      semanticNotice,
    };
  }, [projectId, t]);

  // Stage 1: lexical files/symbols/text/commands start immediately. Abortable
  // calls plus a sequence guard cover both HTTP and Electron IPC transports.
  useEffect(() => {
    if (!open) return;
    const mySeq = ++lexicalSeq.current;
    const controller = new AbortController();
    setSemanticNotice(null);
    // Remove semantic rows from the previous query immediately. If the new
    // semantic stage wins the race, the lexical response merges around it.
    setItems((current) => current.filter((item) => item.kind !== 'semantic'));
    const timer = window.setTimeout(() => void computeLexical(query, tab, controller.signal).then((next) => {
      if (!controller.signal.aborted && lexicalSeq.current === mySeq) {
        setItems((current) => mergeSemantic(
          current.filter((item) => item.kind === 'semantic'),
          next,
        ));
        setHighlight(0);
      }
    }), query.trim() ? 100 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, query, tab, computeLexical]);

  // Stage 2: after 400ms idle, explicit Semantic queries and natural-language
  // queries in All use the owner hybrid pipeline. A new keystroke aborts or
  // discards the previous inference, so reranks never queue per character.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    const shouldRun = (tab === 'semantic' && trimmed.length >= 2)
      || (tab === 'all' && isNaturalLanguageSearch(trimmed));
    const mySeq = ++semanticSeq.current;
    const controller = new AbortController();
    if (!shouldRun) return () => controller.abort();
    const timer = window.setTimeout(() => {
      void computeSemantic(trimmed, controller.signal).then((result) => {
        if (!controller.signal.aborted && semanticSeq.current === mySeq) {
          setItems((current) => mergeSemantic(result.items, current));
          setSemanticNotice(result.semanticNotice);
          setHighlight(0);
        }
      });
    }, 400);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, tab, computeSemantic]);

  const pick = useCallback((item: Item) => {
    close();
    if (item.kind === 'command') {
      executeCommand(item.id);
      return;
    }
    const path = item.kind === 'symbol'
      ? item.hit.file_path
      : item.kind === 'semantic'
        ? (item.hit.data.file_path ?? item.hit.data.path ?? '')
        : item.path;
    if (!path) return;
    if (item.kind === 'semantic' && item.telemetryRequestId) {
      void apiCall('search.outcome', {
        projectId,
        requestId: item.telemetryRequestId,
        semanticWin: item.hit.vector_score != null
          && (item.hit.fts_rank == null || item.hit.fts_rank > 5),
      }).catch(() => undefined);
    }
    onOpenFile(path);
    const target = item.kind === 'symbol'
      ? { line: item.hit.line, col: item.hit.col }
      : item.kind === 'semantic' && item.hit.type === 'symbol'
        ? { line: item.hit.data.line, col: item.hit.data.col }
        : null;
    if (target?.line) {
      const { line } = target;
      const column = target.col ?? 1;
      // The tab mounts async — give Monaco a beat, then reveal.
      setTimeout(() => {
        const editor = getActiveEditor();
        editor?.revealLineInCenter(line);
        editor?.setPosition({ lineNumber: line, column });
        editor?.focus();
      }, 120);
    }
  }, [close, onOpenFile, projectId]);

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
          {TABS.map((tabSpec) => (
            <button
              key={tabSpec.id}
              type="button"
              onClick={() => setTab(tabSpec.id)}
              className={cn(
                'px-2 pb-1.5 text-[11.5px] border-b-2 -mb-px transition-colors',
                tab === tabSpec.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tabSpec.id === 'semantic' ? t('everywhere.semanticTab') : tabSpec.label}
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
            placeholder={tab === 'semantic'
              ? t('everywhere.semanticPlaceholder')
              : 'Type to search files, symbols, text and actions…'}
            className="h-8 text-[12.5px]"
          />
          {(tab === 'semantic' || tab === 'all') && semanticNotice && (
            <p className="px-1 pt-1.5 text-[10.5px] text-amber-500/90">{semanticNotice}</p>
          )}
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
  const { t } = useTranslation('search');
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
  if (item.kind === 'semantic') {
    const h = item.hit;
    const path = h.data.file_path ?? h.data.path ?? '';
    const label = h.data.name ?? path;
    return (
      <button type="button" className={base} onClick={onPick} onMouseMove={onHover}>
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-400" />
        <span className="truncate">{label}</span>
        <span className="text-[10px] text-muted-foreground/70 truncate">
          {path}{h.data.line ? `:${h.data.line}` : ''}
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
          {h.vector_score === null ? t('everywhere.ftsFallback') : h.score.toFixed(3)}
        </span>
      </button>
    );
  }
  const path = item.path;
  const Lead = item.kind === 'recent' ? History : item.kind === 'text' ? Text : FileCode2;
  return (
    <button type="button" className={base} onClick={onPick} onMouseMove={onHover}>
      {item.kind === 'file' ? (
        <FileIcon path={path} className="h-3.5 w-3.5" />
      ) : (
        <Lead className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
      )}
      <span className="truncate">{path}</span>
    </button>
  );
}
