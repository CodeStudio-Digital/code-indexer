/**
 * Explorer (IntelliJ model): lazy directories, virtualized rows (22px),
 * persisted expansion, auto-reveal of the active file, live updates from
 * the fs-events stream (applied by the Workspace-level subscription).
 *
 * Filtering switches to a FLAT result list over the project's indexed
 * file paths (`files.list`) — a lazy tree can't filter what it hasn't
 * loaded, and the flat list covers the whole project instantly.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { RefreshCw, Search, X } from 'lucide-react';
import { Input } from '../../../components/ui/input.js';
import { Button } from '../../../components/ui/button.js';
import { apiCall } from '../../../lib/api-client.js';
import { cn } from '../../../lib/utils.js';
import { fileIconFor } from '../../../lib/file-icon.js';
import { useFileTreeStore, visibleRows } from '../../../state/file-tree.js';
import { FileTreeRow } from './FileTreeRow.js';
import { buildDirSeverity, colorForStatus, commitRename, type GitFileStatus } from './tree-context.js';

interface FileTreeViewProps {
  projectId: number;
  activePath: string | null;
  onOpen: (path: string) => void;
}

export function FileTreeView({ projectId, activePath, onOpen }: FileTreeViewProps) {
  const store = useFileTreeStore();
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [allPaths, setAllPaths] = useState<string[] | null>(null);
  const [gitStatus, setGitStatus] = useState<Map<string, GitFileStatus>>(() => new Map());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (store.projectId !== projectId) store.init(projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- init on project switch only
  }, [projectId]);

  // Auto-reveal the active file (IntelliJ "Always Select Opened File").
  useEffect(() => {
    if (activePath) void store.reveal(activePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  // Git status poll (7s) → file colors + dir severity bubbling.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const status = await apiCall<{ files: Array<{ path: string; state: GitFileStatus; staged: boolean }>; notARepo: boolean }>(
          'projectGit.status', { projectId },
        );
        if (cancelled) return;
        const map = new Map<string, GitFileStatus>();
        if (!status.notARepo) {
          for (const f of status.files) {
            if (!f.staged || !map.has(f.path)) map.set(f.path, f.state);
          }
        }
        // Identity-stable when nothing changed — otherwise the 7s poll
        // re-rendered the whole tree (and rebuilt dirSeverity) every tick.
        setGitStatus((prev) => {
          if (prev.size === map.size && [...map].every(([k, v]) => prev.get(k) === v)) return prev;
          return map;
        });
      } catch {
        if (!cancelled) setGitStatus((prev) => (prev.size === 0 ? prev : new Map()));
      }
      if (!cancelled) timer = setTimeout(tick, 7_000);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [projectId]);

  // F2 renames the active file (when focus isn't in an input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return;
      const t = e.target as HTMLElement | null;
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return;
      if (!activePath) return;
      e.preventDefault();
      setRenamingPath(activePath);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activePath]);

  // Flat filter source — fetched on first use, refreshed on tree refresh.
  useEffect(() => {
    if (!search.trim() || allPaths) return;
    let cancelled = false;
    void apiCall<Array<{ path: string }>>('files.list', { projectId })
      .then((rows) => { if (!cancelled) setAllPaths(rows.map((r) => r.path)); })
      .catch(() => { if (!cancelled) setAllPaths([]); });
    return () => { cancelled = true; };
  }, [search, allPaths, projectId]);

  const dirSeverity = useMemo(() => buildDirSeverity(gitStatus), [gitStatus]);
  const filterActive = search.trim().length > 0;
  const filtered = useMemo(() => {
    if (!filterActive || !allPaths) return [];
    const q = search.trim().toLowerCase();
    return allPaths.filter((p) => p.toLowerCase().includes(q)).slice(0, 300);
  }, [filterActive, allPaths, search]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- version IS the dep
  const rows = useMemo(() => visibleRows(store), [store.version, store.projectId]);
  const count = filterActive ? filtered.length : rows.length;

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 22,
    overscan: 12,
  });

  const onCommitRename = useCallback(
    async (fromPath: string, newName: string) => {
      await commitRename(projectId, fromPath, newName);
      setRenamingPath(null);
    },
    [projectId],
  );

  const refresh = useCallback(() => {
    store.refresh();
    setAllPaths(null);
  }, [store]);

  return (
    <div className="h-full flex flex-col bg-card/30 min-h-0">
      <div className="h-8 shrink-0 border-b flex items-center justify-between px-2.5 gap-1">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em]">Explorer</span>
        <Button variant="ghost" size="icon" className="h-5 w-5 text-muted-foreground hover:text-foreground" onClick={refresh} aria-label="Reload file tree">
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>
      <div className="shrink-0 border-b px-1.5 py-1">
        <div className="relative">
          <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/70 pointer-events-none" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter files…" className="h-6 text-[11px] pl-7 pr-6" />
          {search && (
            <button type="button" onClick={() => setSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 h-4 w-4 grid place-items-center text-muted-foreground/70 hover:text-foreground" aria-label="Clear filter">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto py-1 px-0.5">
        {store.error && <div className="text-[11px] text-destructive px-3 py-2">{store.error}</div>}
        {filterActive && allPaths && filtered.length === 0 && (
          <div className="text-[11px] text-muted-foreground px-3 py-2">No files match &quot;{search}&quot;.</div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const style: React.CSSProperties = {
              position: 'absolute', top: 0, left: 0, width: '100%',
              transform: `translateY(${v.start}px)`, height: 22,
            };
            if (filterActive) {
              const path = filtered[v.index];
              if (!path) return null;
              const { Icon, colorClass } = fileIconFor(path);
              const color = colorForStatus(gitStatus.get(path));
              return (
                <button
                  key={path}
                  type="button"
                  style={style}
                  onClick={() => onOpen(path)}
                  className={cn(
                    'text-left flex items-center gap-1.5 px-1.5 rounded-sm text-[11.5px]',
                    path === activePath ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                  title={path}
                >
                  <Icon className={cn('h-3.5 w-3.5 shrink-0', colorClass)} />
                  <span className={cn('truncate', color.text, color.extra)}>{path}</span>
                </button>
              );
            }
            const row = rows[v.index];
            if (!row) return null;
            const status = row.entry.type === 'dir' ? dirSeverity.get(row.entry.path) : gitStatus.get(row.entry.path);
            return (
              <div key={row.entry.path} style={style}>
                <FileTreeRow
                  entry={row.entry}
                  depth={row.depth}
                  projectId={projectId}
                  active={row.entry.path === activePath}
                  expanded={store.expanded.has(row.entry.path)}
                  status={status}
                  renaming={renamingPath === row.entry.path}
                  onOpen={onOpen}
                  onToggle={store.toggle}
                  onStartRename={setRenamingPath}
                  onCommitRename={(from, name) => void onCommitRename(from, name)}
                  onCancelRename={() => setRenamingPath(null)}
                  onMutated={refresh}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
