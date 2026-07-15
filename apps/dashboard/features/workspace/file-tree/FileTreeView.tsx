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
import { useTranslation } from 'react-i18next';
import { Input } from '../../../components/ui/input.js';
import { Button } from '../../../components/ui/button.js';
import { apiCall } from '../../../lib/api-client.js';
import { startRouteSpan } from '../../../lib/perf/route-startup-metrics.js';
import { cn } from '../../../lib/utils.js';
import { useFileTreeStore, visibleRows } from '../../../state/file-tree.js';
import { useSelectionStore } from '../../../state/file-tree-selection.js';
import { useUiDensity } from '../../../state/ui-density.js';
import { useGitRevision } from '../../../state/git-revision.js';
import { FileTreeRow, type ClickMods } from './FileTreeRow.js';
import { FilteredRow } from './FilteredRow.js';
import { useTreeKeyboard } from './use-tree-keyboard.js';
import { buildDirSeverity, commitRename, type GitFileStatus } from './tree-context.js';
import { WorkbenchPanelHeader } from '../../../components/workbench/index.js';

interface FileTreeViewProps {
  projectId: number;
  active: boolean;
  activePath: string | null;
  /** Native `root_path` of the project — feeds the menu's "Absolute path" copy. */
  projectRoot?: string | null;
  onOpen: (path: string) => void;
  onClose?: () => void;
}

const ACTIVE_GIT_STATUS_POLL_MS = 30_000;

export function FileTreeView({ projectId, active, activePath, projectRoot, onOpen, onClose }: FileTreeViewProps) {
  const { t } = useTranslation('workspace');
  // Seletores ESTREITOS (não o store inteiro): assinar `useFileTreeStore()` sem
  // seletor re-renderizava a árvore a cada mudança de qualquer campo (incl. o set
  // `loading`). Não assinamos `children`/`loading` aqui — `rows` lê o snapshot via
  // getState() keyed em `version`.
  const storeProjectId = useFileTreeStore((s) => s.projectId);
  const version = useFileTreeStore((s) => s.version);
  const expanded = useFileTreeStore((s) => s.expanded);
  const error = useFileTreeStore((s) => s.error);
  const init = useFileTreeStore((s) => s.init);
  const reveal = useFileTreeStore((s) => s.reveal);
  const toggle = useFileTreeStore((s) => s.toggle);
  const refreshStore = useFileTreeStore((s) => s.refresh);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [allPaths, setAllPaths] = useState<string[] | null>(null);
  const [gitStatus, setGitStatus] = useState<Map<string, GitFileStatus>>(() => new Map());
  // Repo flag + root (do mesmo poll de status) → habilita "Git ▸" e o caminho repo-relative.
  const [repo, setRepo] = useState<{ isRepo: boolean; repoRoot: string | null }>({ isRepo: false, repoRoot: null });
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load the tree only once the Files pane is actually shown. It is a keep-alive
  // pane that mounts hidden when the project opens to the default chat tab —
  // firing init() here unconditionally replayed the persisted-expansion restore
  // (a storm of cold `readdir`s, seconds each on a large/Defender-scanned repo)
  // for a tree nobody was looking at, starving the backend on open. The git
  // poll below is already `active`-gated; this mirrors it.
  useEffect(() => {
    if (!active) return;
    if (storeProjectId !== projectId) init(projectId);
    useSelectionStore.getState().init(projectId); // reset seleção na troca de projeto (idempotente)
    setGitStatus(new Map());
    setRepo({ isRepo: false, repoRoot: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- init on project switch / first activation
  }, [projectId, active]);

  // Auto-reveal the active file (IntelliJ "Always Select Opened File") — only
  // once the tree is loaded (pane active), else reveal would force the lazy
  // ancestors to load while the pane is hidden.
  useEffect(() => {
    if (active && activePath) void reveal(activePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, active]);

  // Git status poll (30s base) → file colors + dir severity bubbling. Also
  // keyed on the git-revision: a branch switch / commit (incl. external `git
  // checkout`) re-runs this immediately instead of waiting for the next tick.
  const gitRev = useGitRevision((s) => s.revByProject[projectId] ?? 0);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const finishSpan = startRouteSpan('FileTree:gitStatus', { projectId, tab: 'files' });
      const startedAt = performance.now();
      try {
        const status = await apiCall<{ files: Array<{ path: string; state: GitFileStatus; staged: boolean }>; notARepo: boolean; repoRoot: string | null }>(
          'projectGit.status', { projectId },
        );
        finishSpan({ status: 'ok' });
        if (cancelled) return;
        const map = new Map<string, GitFileStatus>();
        if (!status.notARepo) {
          for (const f of status.files) {
            if (!f.staged || !map.has(f.path)) map.set(f.path, f.state);
          }
        }
        // Identity-stable: só re-renderiza quando o flag/raiz do repo muda de fato.
        setRepo((prev) => {
          const next = { isRepo: !status.notARepo, repoRoot: status.repoRoot };
          return prev.isRepo === next.isRepo && prev.repoRoot === next.repoRoot ? prev : next;
        });
        // Identity-stable when nothing changed — otherwise the poll
        // re-rendered the whole tree (and rebuilt dirSeverity) every tick.
        setGitStatus((prev) => {
          if (prev.size === map.size && [...map].every(([k, v]) => prev.get(k) === v)) return prev;
          return map;
        });
      } catch (err) {
        finishSpan({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      }
      if (cancelled) return;
      // Adaptive backoff: a slow `status` (heavy repo, cold index, no fsmonitor)
      // must NOT re-fire every 30s and hammer the disk. Fast repos keep the 30s
      // cadence; the git-meta watcher still delivers instant refreshes on .git
      // changes, so a longer fallback only delays working-tree-only updates.
      const elapsed = performance.now() - startedAt;
      const next = elapsed > 3_000 ? Math.min(elapsed * 10, 120_000) : ACTIVE_GIT_STATUS_POLL_MS;
      timer = setTimeout(tick, next);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gitRev forces an immediate re-poll
  }, [projectId, gitRev, active]);

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

  // Lê o snapshot children+expanded via getState(), keyed em `version` — evita assinar
  // `children` (cujo Map ref muda a cada load) e recomputa só em mudança estrutural.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version IS the dep
  const rows = useMemo(() => visibleRows(useFileTreeStore.getState()), [version, storeProjectId]);
  const count = filterActive ? filtered.length : rows.length;

  // Altura de linha vem da densidade (Feature 4) — o virtualizer e o style inline
  // precisam do MESMO número, senão as linhas absolutas se sobrepõem.
  const rowH = useUiDensity((s) => s.metrics.treeRowPx);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 12,
  });
  // Re-medir quando a densidade muda (estimateSize fica cacheado).
  useEffect(() => virtualizer.measure(), [rowH, virtualizer]);

  const onCommitRename = useCallback(
    async (fromPath: string, newName: string) => {
      await commitRename(projectId, fromPath, newName);
      setRenamingPath(null);
    },
    [projectId],
  );
  // Callbacks ESTÁVEIS para as rows memoizadas não re-renderizarem por identidade nova.
  const onCancelRename = useCallback(() => setRenamingPath(null), []);
  const onCommitRenameRow = useCallback(
    (from: string, name: string) => void onCommitRename(from, name),
    [onCommitRename],
  );

  const refresh = useCallback(() => {
    refreshStore();
    setAllPaths(null);
  }, [refreshStore]);

  // Refs lidas LAZY dentro dos handlers estáveis (padrão getState-em-vez-de-subscribe):
  // o callback nunca precisa de `rows`/`filtered` na dep array → identidade estável,
  // preservando o memo() das linhas virtualizadas.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  const filterActiveRef = useRef(filterActive);
  filterActiveRef.current = filterActive;

  const getOrder = useCallback(
    () => (filterActiveRef.current ? filteredRef.current : rowsRef.current.map((r) => r.entry.path)),
    [],
  );

  const onRowClick = useCallback(
    (path: string, _isDir: boolean, mods: ClickMods) => {
      const order = getOrder();
      const sel = useSelectionStore.getState();
      if (mods.range) sel.selectRange(path, order);
      else if (mods.additive) sel.toggle(path);
      else sel.setSingle(path);
    },
    [getOrder],
  );

  useTreeKeyboard({ projectId, scrollRef, getOrder, onMutated: refresh });

  return (
    <div className="h-full flex flex-col bg-[var(--workbench-surface)] min-h-0">
      <WorkbenchPanelHeader
        title={t('fileTree.explorer')}
        onClose={onClose}
        actions={
        <Button variant="ghost" size="icon" className="h-5 w-5 text-muted-foreground hover:text-foreground" onClick={refresh} aria-label={t('fileTree.reload')}>
          <RefreshCw className="h-3 w-3" />
        </Button>
        }
      />
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
        {error && <div className="text-[11px] text-destructive px-3 py-2">{error}</div>}
        {filterActive && allPaths && filtered.length === 0 && (
          <div className="text-[11px] text-muted-foreground px-3 py-2">No files match &quot;{search}&quot;.</div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const style: React.CSSProperties = {
              position: 'absolute', top: 0, left: 0, width: '100%',
              transform: `translateY(${v.start}px)`, height: rowH,
            };
            if (filterActive) {
              const path = filtered[v.index];
              if (!path) return null;
              return (
                <FilteredRow
                  key={path}
                  path={path}
                  active={path === activePath}
                  status={gitStatus.get(path)}
                  style={style}
                  onRowClick={onRowClick}
                  onOpen={onOpen}
                />
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
                  expanded={expanded.has(row.entry.path)}
                  status={status}
                  projectRoot={projectRoot}
                  repoRoot={repo.repoRoot}
                  isRepo={repo.isRepo}
                  renaming={renamingPath === row.entry.path}
                  onOpen={onOpen}
                  onToggle={toggle}
                  onRowClick={onRowClick}
                  onStartRename={setRenamingPath}
                  onCommitRename={onCommitRenameRow}
                  onCancelRename={onCancelRename}
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
