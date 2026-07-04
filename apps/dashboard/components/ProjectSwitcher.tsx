/**
 * Quick project switcher — a searchable popover over the user's projects,
 * surfaced in the title-bar breadcrumb and the bottom StatusBar.
 *
 * JetBrains-style: the list is bucketed into **Open Projects** (open in any
 * window), **Recent** (MRU minus open), and **All**. Clicking a project does
 * NOT navigate — it opens an action panel BESIDE the list (Open here / Open in
 * new window / Open in file explorer / Copy path, plus "Switch to its window"
 * for an already-open project). This mirrors the git BranchPopover flyout: a
 * second DOM column INSIDE the popover, never a body portal (a portal would
 * trip Radix Popover's outside-pointer dismissal before the click lands).
 *
 * Fetch is lazy: `/projects` is only hit on first open unless the caller
 * already has the list (AppShell) and passes it via `projects`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronLeft, ChevronRight, ExternalLink, FolderGit2, Pin, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';
import type { ContextMenuItem } from './ui/context-menu.js';
import { buildProjectContextMenuItems } from '../features/project/list/projectContextMenu.js';
import { loadRecentProjects } from '../state/recent-projects.js';
import { hasPin, usePinnedTabs } from '../state/pinned-tabs.js';
import { buildProjectPin } from '../state/pinned-tabs-describe.js';
import { projectPinId } from '../state/pinned-tabs-types.js';
import { useApi } from '../hooks/useApi.js';
import { cn } from '../lib/utils.js';

interface ProjectLite {
  id: number;
  name: string;
  root_path?: string;
}

interface ProjectSwitcherProps {
  currentProjectId: number;
  /** Visual content of the trigger (project name chip) — styled by caller. */
  children: React.ReactNode;
  triggerClassName?: string;
  /** Pre-fetched list (AppShell already has it); omit to fetch lazily on open. */
  projects?: ProjectLite[];
  /** StatusBar sits at the very bottom → open upward. */
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  contentClassName?: string;
}

const SECTION_HEADER =
  'px-2.5 pt-2 pb-1 text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground font-semibold';

export function ProjectSwitcher({
  currentProjectId,
  children,
  triggerClassName,
  projects: provided,
  side = 'bottom',
  align = 'start',
  contentClassName,
}: ProjectSwitcherProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  /** Project whose action panel is open beside the list (drill-in). */
  const [menuProjectId, setMenuProjectId] = useState<number | null>(null);
  /** Project ids open in any window (Electron only; empty in browser dev). */
  const [openProjectIds, setOpenProjectIds] = useState<number[]>([]);
  /** MRU snapshot, refreshed each time the popover opens. */
  const [recentIds, setRecentIds] = useState<number[]>([]);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const { data: fetched } = useApi<ProjectLite[]>(open && !provided ? '/projects' : '');
  const projects = provided ?? fetched ?? [];
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  // Live "open projects" set from the main process (other windows included).
  useEffect(() => {
    const reg = window.electronAPI?.windowRegistry;
    if (!reg) return;
    let alive = true;
    void reg.listOpenProjects().then((list) => {
      if (alive) setOpenProjectIds(list.map((x) => x.projectId));
    });
    const unsub = reg.onOpenProjectsChanged((list) => setOpenProjectIds(list.map((x) => x.projectId)));
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.root_path?.toLowerCase().includes(q) ?? false),
    );
  }, [projects, query]);

  // Bucket the FILTERED list: a project shows in exactly one section, in the
  // order Open → Recent → All.
  const { openList, recentList, allList } = useMemo(() => {
    const openSet = new Set(openProjectIds);
    const filteredIds = new Set(filtered.map((p) => p.id));
    const open = filtered.filter((p) => openSet.has(p.id));
    const openIds = new Set(open.map((p) => p.id));
    const recent = recentIds
      .filter((id) => filteredIds.has(id) && !openIds.has(id))
      .map((id) => byId.get(id))
      .filter((p): p is ProjectLite => !!p);
    const recentSet = new Set(recent.map((p) => p.id));
    const all = filtered.filter((p) => !openIds.has(p.id) && !recentSet.has(p.id));
    return { openList: open, recentList: recent, allList: all };
  }, [filtered, openProjectIds, recentIds, byId]);

  // Flat row order drives keyboard navigation across the three sections.
  const rows = useMemo(() => [...openList, ...recentList, ...allList], [openList, recentList, allList]);
  const indexById = useMemo(() => new Map(rows.map((p, i) => [p.id, i])), [rows]);
  const openSet = useMemo(() => new Set(openProjectIds), [openProjectIds]);

  // Fresh search + MRU on every open; land the cursor on the current project.
  useEffect(() => {
    if (open) {
      setQuery('');
      setMenuProjectId(null);
      setRecentIds(loadRecentProjects());
    }
  }, [open]);
  useEffect(() => {
    if (query) {
      setActive(0);
      return;
    }
    const idx = rows.findIndex((p) => p.id === currentProjectId);
    setActive(Math.max(0, idx));
  }, [rows, query, currentProjectId]);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const openHere = (id: number): void => {
    setOpen(false);
    if (id !== currentProjectId) navigate(`/projects/${id}`);
  };

  const focusWindow = (id: number): void => {
    setOpen(false);
    const reg = window.electronAPI?.windowRegistry;
    if (!reg) {
      navigate(`/projects/${id}`);
      return;
    }
    void reg.focusProject(id).then((r) => {
      if (!r?.ok) navigate(`/projects/${id}`);
    });
  };

  // Reuse the shared project context-menu builder (Open here / new window /
  // explorer / copy path), drop "Edit" (not a switch action), and prepend
  // "Switch to its window" when the project is open in another window.
  const actionItems = (p: ProjectLite): ContextMenuItem[] => {
    const items = buildProjectContextMenuItems({
      project: { id: p.id, name: p.name, root_path: p.root_path ?? '' },
      onSelect: () => openHere(p.id),
      onEdit: () => undefined,
      labels: {
        open: t('projectSwitcher.action.openHere'),
        openInNewWindow: t('projectSwitcher.action.openInNewWindow'),
        openInExplorer: t('projectSwitcher.action.openInExplorer'),
        copyPath: t('projectSwitcher.action.copyPath'),
        edit: '',
        copied: t('projectSwitcher.action.copied'),
      },
    }).filter((i) => i.id !== 'edit');

    if (openSet.has(p.id) && p.id !== currentProjectId) {
      items.unshift({
        id: 'focus-window',
        label: t('projectSwitcher.action.focusWindow'),
        icon: ExternalLink,
        onSelect: () => focusWindow(p.id),
      });
    }
    items.push({
      id: 'pin-project',
      separatorBefore: true,
      label: hasPin(projectPinId(p.id)) ? t('pins:unpin') : t('pins:pin'),
      icon: Pin,
      onSelect: () => usePinnedTabs.getState().togglePin(buildProjectPin({ projectId: p.id, name: p.name })),
    });
    return items;
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (menuProjectId != null && (e.key === 'ArrowLeft' || e.key === 'Backspace')) {
      e.preventDefault();
      setMenuProjectId(null);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault();
      const p = rows[active];
      if (p) setMenuProjectId(p.id);
    }
  };

  const renderRow = (p: ProjectLite): React.ReactNode => {
    const i = indexById.get(p.id) ?? -1;
    const isActive = i === active;
    const isCurrent = p.id === currentProjectId;
    const isOpen = openSet.has(p.id);
    return (
      <button
        key={p.id}
        type="button"
        ref={isActive ? activeRef : undefined}
        onMouseMove={() => setActive(i)}
        onClick={() => setMenuProjectId(p.id)}
        className={cn(
          'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left',
          isActive || menuProjectId === p.id ? 'bg-accent text-accent-foreground' : 'text-foreground',
        )}
      >
        <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{p.name}</span>
          {p.root_path && (
            <span className="block truncate text-[10px] text-muted-foreground">{p.root_path}</span>
          )}
        </span>
        {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
        {isOpen && !isCurrent && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />}
        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
      </button>
    );
  };

  const menuProject = menuProjectId != null ? byId.get(menuProjectId) : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={t('projectSwitcher.trigger')} className={triggerClassName}>
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={6}
        className={cn('flex w-auto p-0 overflow-hidden', contentClassName)}
        onKeyDown={onKeyDown}
        // When the action panel is open, Escape backs out of it instead of
        // dismissing the whole popover.
        onEscapeKeyDown={(e) => {
          if (menuProjectId != null) {
            e.preventDefault();
            setMenuProjectId(null);
          }
        }}
      >
        {/* LIST column */}
        <div className="flex w-[300px] flex-col">
          <div className="flex items-center gap-2 border-b px-2.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('projectSwitcher.placeholder')}
              className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-[360px] overflow-y-auto p-1">
            {rows.length === 0 && (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                {t('projectSwitcher.empty')}
              </div>
            )}
            {openList.length > 0 && (
              <>
                <div className={SECTION_HEADER}>{t('projectSwitcher.section.open')}</div>
                {openList.map(renderRow)}
              </>
            )}
            {recentList.length > 0 && (
              <>
                <div className={SECTION_HEADER}>{t('projectSwitcher.section.recent')}</div>
                {recentList.map(renderRow)}
              </>
            )}
            {allList.length > 0 && (
              <>
                {(openList.length > 0 || recentList.length > 0) && (
                  <div className={SECTION_HEADER}>{t('projectSwitcher.section.all')}</div>
                )}
                {allList.map(renderRow)}
              </>
            )}
          </div>
        </div>

        {/* ACTIONS column — opens BESIDE the list (IntelliJ flyout, no portal). */}
        {menuProject && (
          <div className="w-[210px] border-l bg-popover">
            <ProjectActionPanel
              name={menuProject.name}
              items={actionItems(menuProject)}
              onBack={() => setMenuProjectId(null)}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** One project's action set, rendered inline with a back header (mirrors the
 *  git BranchActionPanel — same no-portal, back-then-run interaction). */
function ProjectActionPanel({
  name,
  items,
  onBack,
}: {
  name: string;
  items: ContextMenuItem[];
  onBack: () => void;
}) {
  return (
    <div className="flex max-h-[400px] flex-col">
      <button
        type="button"
        onClick={onBack}
        className="flex shrink-0 items-center gap-1.5 border-b px-2.5 py-1.5 hover:bg-muted/40"
      >
        <ChevronLeft className="h-3 w-3 text-muted-foreground" />
        <span className="truncate text-[12px] font-medium">{name}</span>
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto py-1 text-[12px]">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              disabled={item.disabled}
              onClick={() => {
                onBack();
                item.onSelect?.();
              }}
              className={cn(
                'flex w-full items-center gap-2 px-2.5 py-1 text-left',
                item.separatorBefore && 'mt-0.5 border-t pt-1.5',
                item.disabled
                  ? 'cursor-not-allowed text-muted-foreground/50'
                  : item.destructive
                    ? 'text-destructive hover:bg-destructive/10'
                    : 'hover:bg-muted/50',
              )}
            >
              {Icon && <Icon className="h-3 w-3 shrink-0" />}
              <span className="flex-1 truncate">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
