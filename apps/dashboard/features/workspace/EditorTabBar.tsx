/**
 * Tab bar above the Monaco editor — one chip per open file, with a
 * dirty indicator, an X-on-hover close button, middle-click close,
 * right-click context menu, and an overflow chevron that lists
 * everything currently open (with a filter input).
 *
 * Keep the tab as a discrete file — the bar scrolls horizontally, and
 * the chevron's dropdown is the escape hatch when there are too many
 * to read at a glance.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Circle, FileCode2, GitBranch, GitCompare, MoreHorizontal, Search, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { useWorkspaceStore, isVirtualTab, type OpenTab } from '../../state/workspace.js';
import { useContextMenu, type ContextMenuItem } from '../../components/ui/context-menu.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { Input } from '../../components/ui/input.js';
import { fileIconFor } from '../../lib/file-icon.js';

/** Icon + color for a tab — virtual surfaces get their own glyph. */
function tabIcon(file: OpenTab): { Icon: React.ComponentType<{ className?: string }>; colorClass: string } {
  if (file.kind === 'git-log') return { Icon: GitBranch, colorClass: 'text-primary' };
  if (file.kind === 'git-stash') return { Icon: Archive, colorClass: 'text-amber-400' };
  if (file.kind === 'diff') return { Icon: GitCompare, colorClass: 'text-amber-300' };
  return fileIconFor(file.path);
}

export function EditorTabBar() {
  const openFiles = useWorkspaceStore((s) => s.openFiles);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const closeFile = useWorkspaceStore((s) => s.closeFile);
  const closeOthers = useWorkspaceStore((s) => s.closeOthers);
  const closeToTheRight = useWorkspaceStore((s) => s.closeToTheRight);
  const closeAll = useWorkspaceStore((s) => s.closeAll);

  // Track whether the inline tab strip is overflowing so we can offer
  // the overflow dropdown only when it's useful.
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
  }, [openFiles.length]);

  // Scroll the active tab into view when it changes (so picking it from
  // Quick Open / the dropdown actually surfaces it).
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>(
      `[data-tab-path="${cssEscape(activeFilePath ?? '')}"]`,
    );
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [activeFilePath]);

  if (openFiles.length === 0) {
    return (
      <div className="h-8 shrink-0 border-b flex items-center px-3 gap-2 bg-card/20">
        <FileCode2 className="h-3 w-3 text-muted-foreground/60" />
        <span className="text-[11px] text-muted-foreground">No file open</span>
      </div>
    );
  }

  return (
    <div className="h-8 shrink-0 border-b flex items-stretch bg-card/20 relative">
      <div
        ref={stripRef}
        className="flex items-stretch overflow-x-auto flex-1 min-w-0"
        // Hide the native scrollbar — the overflow chevron is the
        // affordance we want users to reach for, plus a horizontal bar
        // here clashes with the editor's own scrollbars below.
        style={{ scrollbarWidth: 'none' }}
      >
        {openFiles.map((file) => (
          <TabChip
            key={file.path}
            file={file}
            active={file.path === activeFilePath}
            onActivate={() => setActive(file.path)}
            onClose={() => closeFile(file.path)}
            onCloseOthers={() => closeOthers(file.path)}
            onCloseRight={() => closeToTheRight(file.path)}
            onCloseAll={closeAll}
          />
        ))}
      </div>
      {overflow && (
        <OverflowDropdown
          files={openFiles}
          activeFilePath={activeFilePath}
          onPick={setActive}
          onClose={closeFile}
        />
      )}
    </div>
  );
}

interface TabChipProps {
  file: OpenTab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseRight: () => void;
  onCloseAll: () => void;
}

function TabChip({
  file,
  active,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseRight,
  onCloseAll,
}: TabChipProps) {
  const isVirtual = isVirtualTab(file);
  const display = isVirtual ? file.title : (file.path.split('/').pop() ?? file.path);
  const dirty = !isVirtual && file.dirty;
  // Disk changed under unsaved edits (or the file was deleted) — fs-events
  // stream sets this; saving or reloading clears it.
  const conflicted = !isVirtual && file.externallyChanged === true;
  const { Icon: TypeIcon, colorClass } = tabIcon(file);

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
    {
      id: 'copy-path',
      label: 'Copy path',
      separatorBefore: true,
      onSelect: () => {
        if (isVirtual) return;
        void navigator.clipboard.writeText(file.path).catch(() => undefined);
      },
    },
  ];
  const { triggerProps, Menu } = useContextMenu(items);

  return (
    <>
      <div
        data-tab-path={file.path}
        className={cn(
          'group relative flex items-center gap-1.5 pl-3 pr-1.5 border-r min-w-0 max-w-[240px] shrink-0 cursor-pointer',
          'transition-colors',
          // Active tab "lifts" — slightly raised feel via background + a
          // top accent bar (Cursor / VS Code convention). Inactive tabs
          // sit recessed and only show the icon color so the eye lands
          // on file-type cues without active-tab noise.
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
        {...triggerProps}
        title={isVirtual ? file.title : file.path}
      >
        {/* Active accent bar — top edge, primary tint, 2px so it reads
            confidently. Bottom edge stays clean so the tab and editor
            below share a seamless surface. */}
        {active && (
          <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-primary" />
        )}
        <TypeIcon
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            colorClass,
            !active && 'opacity-80',
          )}
        />
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
            const { Icon, colorClass } = tabIcon(file);
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
                <Icon className={cn('h-3.5 w-3.5 shrink-0', colorClass)} />
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
