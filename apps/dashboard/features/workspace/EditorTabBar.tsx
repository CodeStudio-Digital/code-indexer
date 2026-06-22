/**
 * Tab bar above the Monaco editor — one chip per open file in THIS pane, with
 * a dirty indicator, an X-on-hover close button, middle-click close, right-click
 * context menu, an overflow chevron, drag-to-reorder, and split controls.
 *
 * Pane-aware: it renders the order of the pane identified by `paneId` (the
 * editor supports a 2-pane split). Tabs can be dragged to reorder within the
 * pane or dropped onto another pane to move there. The bar scrolls horizontally;
 * the chevron's dropdown is the escape hatch when there are too many to read.
 */

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  Circle,
  Columns2,
  FileCode2,
  GitBranch,
  GitCompare,
  Minimize2,
  MoreHorizontal,
  MoveRight,
  Play,
  Rows2,
  Search,
  SplitSquareHorizontal,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { useWorkspaceStore, isVirtualTab, type OpenTab } from '../../state/workspace.js';
import { fileRunCommand, runnableForFile } from '../../lib/run-target.js';
import { launchRun } from '../../state/run-launch.js';
import { useContextMenu, type ContextMenuItem } from '../../components/ui/context-menu.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { Input } from '../../components/ui/input.js';
import { FileIcon } from '../../components/FileIcon.js';
import { reloadFromDisk } from './editor/reload-from-disk.js';
import { hasTabPayload, readTabPayload, setTabPayload } from './editor/tab-dnd.js';

/** Icon for a tab — virtual surfaces get their own glyph; files use Material icons. */
function TabIcon({ file, className }: { file: OpenTab; className?: string }) {
  if (file.kind === 'git-log') return <GitBranch className={cn('shrink-0 text-primary', className)} />;
  if (file.kind === 'git-stash') return <Archive className={cn('shrink-0 text-amber-400', className)} />;
  if (file.kind === 'diff') return <GitCompare className={cn('shrink-0 text-amber-300', className)} />;
  return <FileIcon path={file.path} className={className} />;
}

/** Edge of a tab the dragged chip would drop against (drives the insertion line). */
type DropEdge = { path: string; edge: 'left' | 'right' } | null;

interface EditorTabBarProps {
  paneId: string;
}

export function EditorTabBar({ paneId }: EditorTabBarProps) {
  const openFiles = useWorkspaceStore((s) => s.openFiles);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const pane = useWorkspaceStore((s) => s.panes.find((p) => p.id === paneId));
  const splitDir = useWorkspaceStore((s) => s.splitDir);
  const otherPaneId = useWorkspaceStore((s) => s.panes.find((p) => p.id !== paneId)?.id ?? null);

  const setActive = useWorkspaceStore((s) => s.setActive);
  const closeTabInPane = useWorkspaceStore((s) => s.closeTabInPane);
  const closeOthers = useWorkspaceStore((s) => s.closeOthers);
  const closeToTheRight = useWorkspaceStore((s) => s.closeToTheRight);
  const closeAll = useWorkspaceStore((s) => s.closeAll);
  const reorderTab = useWorkspaceStore((s) => s.reorderTab);
  const moveTabToPane = useWorkspaceStore((s) => s.moveTabToPane);
  const splitEditor = useWorkspaceStore((s) => s.splitEditor);
  const unsplit = useWorkspaceStore((s) => s.unsplit);

  const activeFilePath = pane?.activePath ?? null;
  const order = useMemo(() => pane?.order ?? [], [pane?.order]);

  // Resolve this pane's ordered paths against the document pool (active project).
  const byPath = useMemo(() => {
    const m = new Map<string, OpenTab>();
    for (const f of openFiles) if (f.projectId === activeProjectId) m.set(f.path, f);
    return m;
  }, [openFiles, activeProjectId]);
  const tabs = useMemo(
    () => order.map((p) => byPath.get(p)).filter((f): f is OpenTab => f != null),
    [order, byPath],
  );

  const [dropEdge, setDropEdge] = useState<DropEdge>(null);

  // Track whether the inline tab strip is overflowing so we can offer the
  // overflow dropdown only when it's useful.
  const stripRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length]);

  // Scroll the active tab into view when it changes.
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>(
      `[data-tab-path="${cssEscape(activeFilePath ?? '')}"]`,
    );
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [activeFilePath]);

  /** Path that should follow the dropped tab (insert-before semantics). */
  const nextAfter = (path: string): string | null => {
    const i = order.indexOf(path);
    return i >= 0 && i + 1 < order.length ? order[i + 1] : null;
  };

  const onDropOnTab = (targetPath: string, e: DragEvent) => {
    const payload = readTabPayload(e);
    setDropEdge(null);
    if (!payload) return;
    e.preventDefault();
    e.stopPropagation(); // don't also trigger the strip's append handler
    const edge: 'left' | 'right' = dropEdge?.path === targetPath ? dropEdge.edge : 'left';
    const beforePath = edge === 'left' ? targetPath : nextAfter(targetPath);
    if (payload.fromPaneId === paneId) {
      if (payload.path === targetPath) return; // dropped on itself
      reorderTab(paneId, payload.path, beforePath);
    } else {
      moveTabToPane(payload.fromPaneId, paneId, payload.path, beforePath);
    }
  };

  // Strip-level drop (empty area / past the last tab) — cross-pane append.
  const onStripDragOver = (e: DragEvent) => {
    if (!hasTabPayload(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const onStripDrop = (e: DragEvent) => {
    const payload = readTabPayload(e);
    setDropEdge(null);
    if (!payload) return;
    e.preventDefault();
    if (payload.fromPaneId === paneId) {
      reorderTab(paneId, payload.path, null); // drop past the last tab → move to end
    } else {
      moveTabToPane(payload.fromPaneId, paneId, payload.path, null);
    }
  };

  return (
    <div className="h-8 shrink-0 border-b flex items-stretch bg-card/20 relative">
      <div
        ref={stripRef}
        className="flex items-stretch overflow-x-auto flex-1 min-w-0"
        // Hide the native scrollbar — the overflow chevron is the affordance we
        // want users to reach for, and a bar here clashes with the editor's own
        // scrollbars below.
        style={{ scrollbarWidth: 'none' }}
        onDragOver={onStripDragOver}
        onDrop={onStripDrop}
      >
        {tabs.length === 0 ? (
          <div className="flex items-center px-3 gap-2">
            <FileCode2 className="h-3 w-3 text-muted-foreground/60" />
            <span className="text-[11px] text-muted-foreground">No file open</span>
          </div>
        ) : (
          tabs.map((file) => (
            <TabChip
              key={`${file.projectId}:${file.path}`}
              file={file}
              paneId={paneId}
              active={file.path === activeFilePath}
              isSplit={splitDir !== null}
              otherPaneId={otherPaneId}
              dropEdge={dropEdge?.path === file.path ? dropEdge.edge : null}
              onActivate={() => setActive(file.path)}
              onClose={() => closeTabInPane(paneId, file.projectId, file.path)}
              onCloseOthers={() => closeOthers(file.projectId, file.path)}
              onCloseRight={() => closeToTheRight(file.projectId, file.path)}
              onCloseAll={closeAll}
              onDragHover={(edge) => setDropEdge({ path: file.path, edge })}
              onDragLeaveChip={() => setDropEdge((d) => (d?.path === file.path ? null : d))}
              onDropChip={(e) => onDropOnTab(file.path, e)}
              onSplitRight={() => splitEditor('row')}
              onSplitDown={() => splitEditor('column')}
              onMoveToOther={
                otherPaneId ? () => moveTabToPane(paneId, otherPaneId, file.path, null) : undefined
              }
              onUnsplit={unsplit}
            />
          ))
        )}
      </div>
      <RunFileButton file={tabs.find((f) => f.path === activeFilePath)} />
      <SplitMenuButton
        isSplit={splitDir !== null}
        onSplitRight={() => splitEditor('row')}
        onSplitDown={() => splitEditor('column')}
        onUnsplit={unsplit}
      />
      {overflow && (
        <OverflowDropdown
          files={tabs}
          activeFilePath={activeFilePath}
          onPick={setActive}
          onClose={(path) => {
            const f = byPath.get(path);
            if (f) closeTabInPane(paneId, f.projectId, path);
          }}
        />
      )}
    </div>
  );
}

/** ▶ Run button for the active file — only shown when its extension is runnable. */
function RunFileButton({ file }: { file: OpenTab | undefined }) {
  const { t } = useTranslation('workspace');
  if (!file || isVirtualTab(file)) return null;
  const target = runnableForFile(file.path);
  if (!target) return null;
  const base = file.path.split('/').pop() ?? file.path;
  return (
    <button
      type="button"
      className="h-8 px-2.5 shrink-0 border-l grid place-items-center text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 transition-colors"
      title={t('run.runFile')}
      aria-label={t('run.runFile')}
      onClick={() =>
        void launchRun({
          projectId: file.projectId,
          command: fileRunCommand(file.path, target.runtime),
          label: `Run ${base}`,
          manager: target.manager,
        })
      }
    >
      <Play className="h-3.5 w-3.5" />
    </button>
  );
}

/** Split / unsplit control (right cluster). */
function SplitMenuButton({
  isSplit,
  onSplitRight,
  onSplitDown,
  onUnsplit,
}: {
  isSplit: boolean;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onUnsplit: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="h-8 w-8 shrink-0 border-l grid place-items-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
          aria-label="Split editor"
          title="Split editor"
        >
          <SplitSquareHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={onSplitRight}>
          <Columns2 />
          Split Right
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onSplitDown}>
          <Rows2 />
          Split Down
        </DropdownMenuItem>
        {isSplit && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onUnsplit}>
              <Minimize2 />
              Unsplit
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface TabChipProps {
  file: OpenTab;
  paneId: string;
  active: boolean;
  isSplit: boolean;
  otherPaneId: string | null;
  dropEdge: 'left' | 'right' | null;
  onActivate: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseRight: () => void;
  onCloseAll: () => void;
  onDragHover: (edge: 'left' | 'right') => void;
  onDragLeaveChip: () => void;
  onDropChip: (e: DragEvent) => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onMoveToOther?: () => void;
  onUnsplit: () => void;
}

function TabChip({
  file,
  paneId,
  active,
  isSplit,
  dropEdge,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseRight,
  onCloseAll,
  onDragHover,
  onDragLeaveChip,
  onDropChip,
  onSplitRight,
  onSplitDown,
  onMoveToOther,
  onUnsplit,
}: TabChipProps) {
  const isVirtual = isVirtualTab(file);
  const display = isVirtual ? file.title : (file.path.split('/').pop() ?? file.path);
  const dirty = !isVirtual && file.dirty;
  // Disk changed under unsaved edits (or the file was deleted) — fs-events
  // stream sets this; saving or reloading clears it.
  const conflicted = !isVirtual && file.externallyChanged === true;

  const items: ContextMenuItem[] = [
    { id: 'close', label: 'Close', onSelect: onClose },
    { id: 'close-others', label: 'Close others', onSelect: onCloseOthers },
    { id: 'close-right', label: 'Close all to the right', onSelect: onCloseRight },
    {
      id: 'close-all',
      label: 'Close all',
      separatorBefore: true,
      destructive: true,
      onSelect: onCloseAll,
    },
    { id: 'split-right', label: 'Split Right', icon: Columns2, separatorBefore: true, onSelect: onSplitRight },
    { id: 'split-down', label: 'Split Down', icon: Rows2, onSelect: onSplitDown },
    ...(isSplit && onMoveToOther
      ? [{ id: 'move-other', label: 'Move to Other Group', icon: MoveRight, onSelect: onMoveToOther } as ContextMenuItem]
      : []),
    ...(isSplit ? [{ id: 'unsplit', label: 'Unsplit', icon: Minimize2, onSelect: onUnsplit } as ContextMenuItem] : []),
    {
      id: 'copy-path',
      label: 'Copy path',
      separatorBefore: true,
      onSelect: () => {
        if (isVirtual) return;
        void navigator.clipboard.writeText(file.path).catch(() => undefined);
      },
    },
    ...(!isVirtual
      ? [
          {
            id: 'reload-disk',
            label: 'Reload from disk',
            onSelect: () => void reloadFromDisk(file.projectId, file.path),
          } as ContextMenuItem,
        ]
      : []),
  ];
  const { triggerProps, Menu } = useContextMenu(items);

  return (
    <>
      <div
        data-tab-path={file.path}
        draggable
        className={cn(
          'group relative flex items-center gap-1.5 pl-3 pr-1.5 border-r min-w-0 max-w-[240px] shrink-0 cursor-pointer',
          'transition-colors',
          // Active tab "lifts" — slightly raised feel via background + a top
          // accent bar (Cursor / VS Code convention). Inactive tabs sit recessed.
          active
            ? 'bg-background text-foreground'
            : 'bg-card/10 text-muted-foreground hover:bg-muted/40 hover:text-foreground',
        )}
        onClick={onActivate}
        onMouseDown={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            onClose();
          }
        }}
        onDragStart={(e) => setTabPayload(e, { path: file.path, fromPaneId: paneId })}
        onDragOver={(e) => {
          if (!hasTabPayload(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const rect = e.currentTarget.getBoundingClientRect();
          onDragHover(e.clientX - rect.left < rect.width / 2 ? 'left' : 'right');
        }}
        // Native DnD fires dragleave when crossing onto a child node (icon,
        // label, close button). Ignore those so the insertion line doesn't
        // flicker — only clear when the pointer truly leaves the chip.
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          onDragLeaveChip();
        }}
        onDrop={onDropChip}
        {...triggerProps}
        title={isVirtual ? file.title : file.path}
      >
        {/* Insertion line — vertical primary bar at the edge the drop lands on. */}
        {dropEdge === 'left' && <span aria-hidden className="absolute left-0 inset-y-0 w-0.5 bg-primary z-10" />}
        {dropEdge === 'right' && <span aria-hidden className="absolute right-0 inset-y-0 w-0.5 bg-primary z-10" />}
        {/* Active accent bar — top edge, primary tint, 2px. */}
        {active && <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-primary" />}
        <TabIcon file={file} className={cn('h-3.5 w-3.5', !active && 'opacity-80')} />
        <span className={cn('text-[11.5px] truncate font-medium', active && 'tracking-tight', conflicted && 'text-amber-400')}>
          {display}
        </span>
        {conflicted && (
          <span
            aria-hidden
            title="Changed on disk while you have unsaved edits — saving overwrites the disk version"
            className="shrink-0 h-1.5 w-1.5 rounded-full bg-amber-400"
          />
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            'shrink-0 h-4 w-4 rounded-sm grid place-items-center hover:bg-muted transition-colors',
            dirty ? 'text-foreground' : 'text-muted-foreground/70',
          )}
          aria-label={`Close ${display}`}
        >
          {dirty ? (
            <>
              <Circle className="h-2 w-2 fill-current group-hover:hidden" />
              <X className="h-3 w-3 hidden group-hover:block" />
            </>
          ) : (
            <X className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
          )}
        </button>
      </div>
      {Menu}
    </>
  );
}

interface OverflowDropdownProps {
  files: OpenTab[];
  activeFilePath: string | null;
  onPick: (path: string) => void;
  onClose: (path: string) => void;
}

function OverflowDropdown({ files, activeFilePath, onPick, onClose }: OverflowDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const dirty = files.filter((f) => !isVirtualTab(f) && f.dirty).length;

  const filtered = useMemo(() => {
    if (!query.trim()) return files;
    const q = query.toLowerCase();
    return files.filter((f) => {
      const label = isVirtualTab(f) ? f.title : f.path;
      return label.toLowerCase().includes(q);
    });
  }, [files, query]);

  // Reset filter every time the menu reopens.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="h-8 w-8 shrink-0 border-l grid place-items-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors relative"
          aria-label="Open file list"
          title={`${files.length} open · ${dirty} unsaved`}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
          {dirty > 0 && (
            <span
              aria-hidden
              className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-primary"
            />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0 overflow-hidden">
        <div className="p-1.5 border-b">
          <div className="relative">
            <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Filter ${files.length} open file${files.length === 1 ? '' : 's'}…`}
              className="h-7 text-[12px] pl-7"
              autoFocus
            />
          </div>
        </div>
        <div className="max-h-[320px] overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-3 py-3 text-[11px] text-muted-foreground text-center">
              No tabs match &quot;{query}&quot;.
            </div>
          )}
          {filtered.map((file) => {
            const isVirtual = isVirtualTab(file);
            const display = isVirtual ? file.title : (file.path.split('/').pop() ?? file.path);
            const subtitle = isVirtual ? '' : (file.path.includes('/') ? posixDirname(file.path) : '');
            const dirtyOne = !isVirtual && file.dirty;
            const active = file.path === activeFilePath;
            return (
              <div
                key={file.path}
                className={cn(
                  'group flex items-center gap-2 px-3 py-1.5 cursor-pointer',
                  active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/40',
                )}
                onClick={() => {
                  onPick(file.path);
                  setOpen(false);
                }}
                title={isVirtual ? file.title : file.path}
              >
                <TabIcon file={file} className="h-3.5 w-3.5" />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium truncate flex items-center gap-1.5">
                    {display}
                    {dirtyOne && <Circle className="h-2 w-2 fill-primary text-primary" />}
                  </div>
                  {subtitle && (
                    <div className="text-[10px] text-muted-foreground/80 truncate font-mono">
                      {subtitle}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="h-5 w-5 shrink-0 rounded-sm grid place-items-center text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(file.path);
                  }}
                  aria-label={`Close ${display}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function posixDirname(p: string): string {
  const ix = p.lastIndexOf('/');
  return ix <= 0 ? '' : p.slice(0, ix);
}

// CSS.escape isn't on older browsers but Electron's Chromium ships it.
// Wrap so we can fall back if a renderer ever lacks it.
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return value.replace(/(["\\\]])/g, '\\$1');
}
