import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  ArchiveRestore,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderPlus,
  FolderX,
  FileInput,
  Inbox,
  Loader2,
  MessageSquareCode,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Square,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { ScrollArea } from '../../components/ui/scroll-area.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js';
import { cn, formatRelativeTime } from '../../lib/utils.js';
import { usePinnedTabs } from '../../state/pinned-tabs.js';
import { useSessionActivity } from './useSessionActivity.js';
import { groupSessionBranches, SESSION_TREE_INDENT_LIMIT, visibleSessionBranches, type SessionBranch } from './session-lineage.js';
export { isExecutingSessionStatus } from './session-activity.js';
import { providerAccent, providerLabel, workspaceColor, type AccentColor } from './constants.js';
import type {
  CoderSession,
  CoderSessionGroup,
} from './types.js';

export type SessionView = 'active' | 'archived';

interface SessionSidebarProps {
  actionsHost?: HTMLElement | null;
  scopeKey?: string;
  newDisabled?: boolean;
  sessions: CoderSession[] | null;
  groups: CoderSessionGroup[] | null;
  selectedId: string | null;
  view: SessionView;
  onViewChange: (view: SessionView) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  creating?: boolean;
  onImport?: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, currentTitle: string) => void;
  onDuplicate: (id: string) => Promise<void> | void;
  onBatchDelete: (ids: string[]) => Promise<void> | void;
  onDeleteAll: () => Promise<void> | void;
  onArchive: (id: string, archived: boolean) => Promise<void> | void;
  onFavorite: (id: string, favorite: boolean) => Promise<void> | void;
  /** Toggle a Pinned Tab for this session (optional — enables the Pin menu item). */
  onTogglePin?: (id: string) => void;
  /** Deterministic pin id for a session id — lets a row reflect pinned state. */
  sessionPinId?: (id: string) => string;
  onBatchArchive: (ids: string[], archived: boolean) => Promise<void> | void;
  onMoveToGroup: (id: string, groupId: string | null) => Promise<void> | void;
  onBatchMoveToGroup: (ids: string[], groupId: string | null) => Promise<void> | void;
  onCreateGroup: () => void;
  onRenameGroup: (group: CoderSessionGroup) => void;
  onDeleteGroup: (group: CoderSessionGroup) => void;
  projectName: string;
  /**
   * How to bucket the list. `'group'` (default) — the per-project named folders
   * (`group_id`). `'workspace'` — Sessões Globais: auto-group by the primary
   * linked project (`project_id`), header = `workspace_label`,
   * each workspace gets a stable accent color. Manual-group controls are hidden
   * in `'workspace'` mode (groups are per-project).
   */
  groupBy?: 'group' | 'workspace';
  /** Mobile drawer open state. On mobile the sidebar is a slide-in overlay. */
  mobileOpen?: boolean;
  /** Called when the mobile drawer should close (backdrop tap, X button). */
  onMobileClose?: () => void;
  /** Fill a permanent workbench dock instead of becoming a viewport-sized drawer. */
  docked?: boolean;
}

const UNGROUPED_KEY = '__ungrouped__';

export function sessionSidebarClassName(docked: boolean, mobileOpen: boolean): string {
  return cn(
    'flex flex-col bg-[var(--workbench-surface)] overflow-hidden @container',
    docked
      ? 'static inset-auto z-auto h-full w-full max-w-none translate-x-0 rounded-none border-0 border-r shadow-none transition-none'
      : cn(
          'fixed inset-y-0 left-0 z-50 w-[85%] max-w-[320px] rounded-r-xl border shadow-2xl',
          'transition-transform duration-200 ease-out',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          'lg:static lg:inset-auto lg:z-auto lg:h-full lg:w-full lg:max-w-none lg:translate-x-0',
          'lg:rounded-none lg:border-0 lg:border-r lg:shadow-none lg:transition-none',
        ),
  );
}

// React.memo: the parent (AgentChat) re-renders on every click / stream frame,
// but the sidebar only depends on the session list + stable handlers. With all
// handler props now useCallback-stabilized in AgentChat (and `sessions`/`groups`
// being useApi state refs), this memo holds across the click-storm — the inner
// SessionRow memo was previously defeated by the unstable handlers flowing
// through here.
export const SessionSidebar = memo(function SessionSidebar({
  actionsHost,
  scopeKey,
  newDisabled = false,
  sessions,
  groups,
  selectedId,
  view,
  onViewChange,
  onSelect,
  onNew,
  creating = false,
  onImport,
  onDelete,
  onRename,
  onDuplicate,
  onBatchDelete,
  onDeleteAll,
  onArchive,
  onFavorite,
  onTogglePin,
  sessionPinId,
  onBatchArchive,
  onMoveToGroup,
  onBatchMoveToGroup,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  projectName,
  groupBy = 'group',
  mobileOpen = false,
  onMobileClose,
  docked = false,
}: SessionSidebarProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [selectMode, setSelectMode] = useState(false);
  const [runningOnly, setRunningOnly] = useState(false);
  const executingSessionIds = useSessionActivity(sessions);
  // Workspace mode (Sessões Globais) auto-buckets by virtual workspace; the
  // per-project named-folder controls don't apply there.
  const showGroups = groupBy === 'group';

  // Close the drawer on Escape so mobile users aren't trapped.
  useEffect(() => {
    if (docked || !mobileOpen || !onMobileClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onMobileClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [docked, mobileOpen, onMobileClose]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelectedIds(new Set());
    setSelectMode(false);
  }, [scopeKey, view]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [collapsedBranches, setCollapsedBranches] = useState<Set<string>>(new Set());
  const toggleBranch = useCallback((id: string) => {
    setCollapsedBranches(previous => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (view === 'archived') setRunningOnly(false);
  }, [view]);

  // Stable so `memo(SessionRow)` isn't defeated — passed straight to every row.
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const toggleGroupCollapse = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Build grouped view. Each entry carries an optional `label`/`accent` so the
  // workspace mode can render its own header (label + color) without a real
  // `CoderSessionGroup` row.
  type GroupEntry = {
    key: string;
    group: CoderSessionGroup | null;
    roots: SessionBranch[];
    count: number;
    label?: string;
    accent?: AccentColor;
  };
  const { grouped, parents } = useMemo(() => {
    const list = (sessions ?? []).filter(
      (session) => !runningOnly || executingSessionIds.has(session.id),
    );
    const knownGroups = new Set((groups ?? []).map(group => String(group.id)));
    const tree = groupSessionBranches(list, session => {
      if (groupBy === 'workspace') return String(session.project_id);
      const group = session.group_id;
      return group && knownGroups.has(group) ? group : undefined;
    }, UNGROUPED_KEY);

    // Sessões Globais: bucket by their primary real project,
    // in first-appearance order (the list is already sorted by favorite+recency).
    if (groupBy === 'workspace') {
      const grouped = [...tree.groups].map(([key, bucket]): GroupEntry => {
        const head = bucket.roots[0].session;
        return {
          key,
          group: null,
          ...bucket,
          label: head.workspace_label || head.project_name || head.title,
          accent: workspaceColor(head.project_id),
        };
      });
      return { grouped, parents: tree.parents };
    }

    // Per-project: keep group sort_order, then ungrouped at the end.
    const ordered: GroupEntry[] = [];
    for (const g of groups ?? []) {
      const key = String(g.id);
      const bucket = tree.groups.get(key);
      if (bucket) ordered.push({ key, group: g, ...bucket });
    }
    const ungrouped = tree.groups.get(UNGROUPED_KEY);
    if (ungrouped) {
      ordered.push({ key: UNGROUPED_KEY, group: null, ...ungrouped });
    }
    return { grouped: ordered, parents: tree.parents };
  }, [sessions, groups, groupBy, runningOnly, executingSessionIds]);

  const visibleGroups = useMemo(() => grouped.map(entry => {
    const collapsed = collapsedGroups.has(entry.key);
    return {
      ...entry,
      collapsed,
      rows: collapsed ? [] : visibleSessionBranches(entry.roots, collapsedBranches),
    };
  }), [grouped, collapsedGroups, collapsedBranches]);

  const selectedAncestorIds: string[] = [];
  for (let parent = parents.get(selectedId ?? ''); parent; parent = parents.get(parent)) {
    selectedAncestorIds.push(parent);
  }
  const selectedAncestors = selectedAncestorIds.join(',');
  useEffect(() => {
    if (!selectedAncestors) return;
    setCollapsedBranches(previous => {
      const toExpand = selectedAncestors.split(',').filter(id => previous.has(id));
      return toExpand.length > 0 ? new Set([...previous].filter(id => !toExpand.includes(id))) : previous;
    });
  }, [selectedAncestors, selectedId]);

  const selectedCount = selectedIds.size;
  const runningCount = useMemo(
    () => (sessions ?? []).filter((session) => executingSessionIds.has(session.id)).length,
    [executingSessionIds, sessions],
  );
  const selectedArray = useMemo(() => Array.from(selectedIds), [selectedIds]);
  const isArchivedView = view === 'archived';
  // Stable array identity for the rows' move-to-group submenu (was `groups ?? []`
  // recreated inline per render, which defeated the row memo).
  const rowGroups = useMemo(() => groups ?? [], [groups]);

  const actions = (
      <div className={cn(
        'flex items-center gap-2 px-2',
        actionsHost ? 'h-7' : 'min-h-9 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] @max-[240px]:px-1 @max-[240px]:py-1',
      )}>
        <div className={cn('flex min-w-0 items-center gap-1.5', !actionsHost && '@max-[240px]:hidden')}>
          <MessageSquareCode className="h-4 w-4 text-primary shrink-0" />
          {/* Some quando a barra aperta — sobra o ícone + as ações. */}
          <span className="text-xs font-semibold truncate @max-[180px]:hidden">{t('chat:sidebar.sessions')}</span>
        </div>
        <div className={cn(
          'ml-auto flex shrink-0 items-center gap-0.5',
          !actionsHost && '@max-[240px]:min-w-0 @max-[240px]:shrink @max-[240px]:flex-wrap @max-[240px]:justify-end @max-[240px]:gap-0 @max-[240px]:[&>button]:h-6 @max-[240px]:[&>button]:px-1 @max-[240px]:[&>button:not(.w-auto)]:w-6',
        )}>
          {!isArchivedView && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant={runningOnly ? 'secondary' : 'ghost'}
                  className={cn(
                    'h-7 w-auto min-w-7 gap-1 px-1.5 font-mono text-[10px] tabular-nums',
                    (runningOnly || runningCount > 0) && 'text-emerald-400',
                  )}
                  onClick={() => setRunningOnly((current) => !current)}
                  aria-pressed={runningOnly}
                  aria-label={runningOnly ? t('chat:sidebar.showAll') : t('chat:sidebar.showRunning')}
                >
                  <Loader2
                    className={cn(
                      'h-3.5 w-3.5',
                      runningCount > 0 && 'animate-spin motion-reduce:animate-none',
                    )}
                  />
                  <span>{runningCount}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {runningOnly
                  ? t('chat:sidebar.showAll')
                  : t('chat:sidebar.runningCount', { count: runningCount })}
              </TooltipContent>
            </Tooltip>
          )}
          {/* View filter — replaces the active/archived segmented control.
              The trigger icon reflects the current view at a glance. */}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-auto px-1.5 gap-0.5"
                    aria-label={t('chat:sidebar.viewFilter')}
                  >
                    {isArchivedView ? <Archive className="h-3.5 w-3.5" /> : <Inbox className="h-3.5 w-3.5" />}
                    <ChevronDown className="h-3 w-3 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{t('chat:sidebar.viewFilter')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onViewChange('active')}>
                <Inbox />
                {t('chat:sidebar.active')}
                {view === 'active' && <Check className="ml-auto" />}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onViewChange('archived')}>
                <Archive />
                {t('chat:sidebar.archived')}
                {view === 'archived' && <Check className="ml-auto" />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant={selectMode ? 'default' : 'ghost'}
                className="h-7 w-7"
                onClick={() => {
                  if (selectMode) exitSelectMode();
                  else setSelectMode(true);
                }}
                aria-label={t('chat:sidebar.toggleSelect')}
              >
                <CheckSquare className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{selectMode ? t('chat:sidebar.exitSelect') : t('chat:sidebar.selectMultiple')}</TooltipContent>
          </Tooltip>
          {showGroups && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={onCreateGroup}
                  aria-label={t('chat:sidebar.newGroup')}
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('chat:sidebar.newGroup')}</TooltipContent>
            </Tooltip>
          )}
          {sessions && sessions.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => onDeleteAll()}
                  aria-label={t('chat:sidebar.deleteAll')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('chat:sidebar.deleteAll')}</TooltipContent>
            </Tooltip>
          )}
          {!docked && onMobileClose && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 lg:hidden"
              onClick={onMobileClose}
              aria-label={t('chat:sidebar.closeSessions')}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
          {onImport && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={onImport}
                  aria-label={t('chat:sessionImport.title')}
                >
                  <FileInput className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('chat:sessionImport.title')}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={onNew}
                disabled={creating || newDisabled}
                aria-busy={creating}
                aria-label={t('chat:sidebar.new')}
              >
                {creating
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Plus className="h-3.5 w-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {creating
                ? t('chat:sessionLaunch.creating')
                : t('chat:sidebar.new')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
  );

  return (
    <>
      {/* Mobile backdrop — only visible below lg when the drawer is open. */}
      {!docked && mobileOpen && (
        <div
          className="fixed inset-0 bg-background/80 backdrop-blur-sm z-40 lg:hidden"
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={sessionSidebarClassName(docked, mobileOpen)}
      >
      {actionsHost ? createPortal(actions, actionsHost) : actions}

      {/* Batch-action bar */}
      {selectMode && selectedCount > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-b bg-muted/40 px-2 py-1.5 text-xs">
          <span className="font-medium">{t('chat:sidebar.selected', { count: selectedCount })}</span>
          <div className="ml-auto flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  onClick={async () => {
                    await onBatchArchive(selectedArray, !isArchivedView);
                    exitSelectMode();
                  }}
                  aria-label={isArchivedView ? t('chat:sidebar.unarchive') : t('chat:sidebar.archive')}
                >
                  {isArchivedView ? (
                    <ArchiveRestore className="h-3.5 w-3.5" />
                  ) : (
                    <Archive className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{isArchivedView ? t('chat:sidebar.unarchive') : t('chat:sidebar.archive')}</TooltipContent>
            </Tooltip>

            {showGroups && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" className="h-6 w-6" aria-label={t('chat:sidebar.moveToGroup')}>
                    <FolderPlus className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>{t('chat:sidebar.moveToGroup')}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={async () => {
                      await onBatchMoveToGroup(selectedArray, null);
                      exitSelectMode();
                    }}
                  >
                    {t('chat:sidebar.noGroup')}
                  </DropdownMenuItem>
                  {(groups ?? []).map((g) => (
                    <DropdownMenuItem
                      key={g.id}
                      onClick={async () => {
                        await onBatchMoveToGroup(selectedArray, g.id);
                        exitSelectMode();
                      }}
                    >
                      {g.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 text-destructive hover:text-destructive"
                  onClick={async () => {
                    await onBatchDelete(selectedArray);
                    exitSelectMode();
                  }}
                  aria-label={t('chat:sidebar.deleteSelected')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('chat:sidebar.deleteSelected')}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}

      <ScrollArea className="flex-1 w-full chat-scroll">
        <div className="space-y-2 px-1.5 py-1.5 [--session-indent:12px] @max-[210px]:[--session-indent:9px]">
          {((sessions?.length === 0) || (runningOnly && runningCount === 0)) && (
            <div className="p-4 text-xs text-muted-foreground text-center">
              {runningOnly
                ? t('chat:sidebar.noRunning')
                : isArchivedView
                ? t('chat:sidebar.noArchived', { name: projectName })
                : t('chat:sidebar.noSessions', { name: projectName })}
            </div>
          )}

          {visibleGroups.map(({ key, group, rows, count, label, accent, collapsed }) => {
            const headerLabel = label ?? (group ? group.name : t('chat:sidebar.ungrouped'));
            return (
              <div key={key}>
                <div className="group/hdr mb-0.5 flex h-[22px] items-center gap-1 px-1 text-[11px] leading-none text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => toggleGroupCollapse(key)}
                    aria-expanded={!collapsed}
                    className="flex h-full min-w-0 flex-1 items-center gap-1 rounded-sm text-start focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring"
                  >
                    {collapsed ? (
                      <ChevronRight className="mx-0.5 size-3 shrink-0" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="mx-0.5 size-3 shrink-0" aria-hidden="true" />
                    )}
                    {accent && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: accent.solid }}
                        aria-hidden="true"
                      />
                    )}
                    <span
                      className="truncate font-medium transition-colors group-hover/hdr:text-foreground"
                      title={headerLabel}
                    >
                      {headerLabel}
                    </span>
                    <span className="ml-1 shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {count}
                    </span>
                  </button>
                  {group && (
                    <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/hdr:opacity-100 group-focus-within/hdr:opacity-100 pointer-coarse:opacity-100">
                      <button
                        type="button"
                        onClick={() => onRenameGroup(group)}
                        aria-label={t('chat:sidebar.renameGroup')}
                        className="rounded p-0.5 hover:bg-muted"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteGroup(group)}
                        aria-label={t('chat:sidebar.deleteGroup')}
                        className="rounded p-0.5 hover:bg-muted text-destructive"
                      >
                        <FolderX className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>
                {rows.map(({ branch: { session: s, children }, depth, ancestorGuides, hasNextSibling }) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      selected={selectedId === s.id}
                      selectMode={selectMode}
                      checked={selectedIds.has(s.id)}
                      onToggle={toggleSelected}
                      onSelect={onSelect}
                      onDelete={onDelete}
                      onRename={onRename}
                      onDuplicate={onDuplicate}
                      onArchive={onArchive}
                      onFavorite={onFavorite}
                      onTogglePin={onTogglePin}
                      sessionPinId={sessionPinId}
                      isArchivedView={isArchivedView}
                      groups={rowGroups}
                      onMoveToGroup={onMoveToGroup}
                      showGroups={showGroups}
                      accent={accent}
                      running={executingSessionIds.has(s.id)}
                      depth={depth}
                      ancestorGuides={ancestorGuides}
                      hasNextSibling={hasNextSibling}
                      expanded={children.length > 0 ? !collapsedBranches.has(s.id) : undefined}
                      onToggleBranch={toggleBranch}
                    />
                  ))}
              </div>
            );
          })}
        </div>
      </ScrollArea>
      </aside>
    </>
  );
});

/** Compact, software-style token figure: 13_796_002 → "13.8M", 1_839_937 → "1.8M",
 *  9_412 → "9.4K", 945 → "945". The exact value lives in the row's native title. */
function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = n / 1000;
    return `${(v < 10 ? v.toFixed(1) : Math.round(v).toString()).replace(/\.0$/, '')}K`;
  }
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
}

const SessionRow = memo(function SessionRow({
  session: s,
  selected,
  selectMode,
  checked,
  onToggle,
  onSelect,
  onDelete,
  onRename,
  onDuplicate,
  onArchive,
  onFavorite,
  onTogglePin,
  sessionPinId,
  isArchivedView,
  groups,
  onMoveToGroup,
  showGroups,
  accent,
  running,
  depth,
  ancestorGuides,
  hasNextSibling,
  expanded,
  onToggleBranch,
}: {
  session: CoderSession;
  selected: boolean;
  selectMode: boolean;
  checked: boolean;
  // Stable parent callbacks (id-taking) — the row binds its own session.id, so
  // the parent never allocates a per-row closure and the memo holds.
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, currentTitle: string) => void;
  onDuplicate: (id: string) => Promise<void> | void;
  onArchive: (id: string, archived: boolean) => Promise<void> | void;
  onFavorite: (id: string, favorite: boolean) => Promise<void> | void;
  onTogglePin?: (id: string) => void;
  sessionPinId?: (id: string) => string;
  isArchivedView: boolean;
  groups: CoderSessionGroup[];
  onMoveToGroup: (id: string, groupId: string | null) => Promise<void> | void;
  /** Per-project named groups don't apply in global (workspace) mode. */
  showGroups: boolean;
  /** Workspace accent shared with the group and chat headers. */
  accent?: AccentColor;
  /** Authoritative persisted status combined with the renderer's live transport registry. */
  running: boolean;
  depth: number;
  ancestorGuides: readonly number[];
  hasNextSibling: boolean;
  expanded?: boolean;
  onToggleBranch: (id: string) => void;
}) {
  const { t, i18n } = useTranslation(['chat', 'common']);
  const pinId = sessionPinId?.(s.id);
  const pinned = usePinnedTabs((st) => (pinId ? st.pins.some((p) => p.id === pinId) : false));
  const tokens = s.total_input_tokens + s.total_output_tokens;
  const updated = formatRelativeTime(s.updated_at);
  const tokenDetails = `${tokens.toLocaleString(i18n.resolvedLanguage)} tokens`;
  const details = [
    `${providerLabel(s.provider)} · ${s.model}`,
    running && t('chat:sidebar.running'),
    s.import_source && t(s.import_source === 'claude-code' ? 'chat:sessionImport.claudeCode' : 'chat:sessionImport.codex'),
    `${updated} · ${tokenDetails}`,
  ].filter(Boolean);
  const indent = Math.min(depth, SESSION_TREE_INDENT_LIMIT);
  const handleClick = () => {
    if (selectMode) onToggle(s.id);
    else onSelect(s.id);
  };
  // Visual states. `isActive` paints the soft tint + primary left rule for the
  // open session; `isChecked` is the assertive multi-select band (outranks
  // active). Hover only when neither is set so the states never fight.
  const isActive = selected && !selectMode;
  const isChecked = selectMode && checked;
  return (
    <div
      data-session-id={s.id}
      data-session-depth={depth}
      data-session-running={running ? 'true' : 'false'}
      onClick={handleClick}
      style={{ paddingInlineStart: `calc(4px + ${indent} * var(--session-indent))` }}
      className={cn(
        'group/session relative flex h-[calc(var(--ide-tree-row)+2px)] min-w-0 cursor-pointer items-center gap-1.5 rounded-sm pe-1.5 transition-colors pointer-coarse:min-h-8',
        'before:pointer-events-none before:absolute before:inset-y-1 before:start-0 before:w-0.5 before:rounded-full',
        !isActive && !isChecked && 'hover:bg-[var(--workbench-hover)]',
        isActive && 'bg-[var(--workbench-active)] before:bg-[var(--workbench-focus)] hover:bg-[var(--workbench-active)]',
        isChecked && 'bg-[var(--workbench-active)] before:bg-[var(--workbench-focus)] ring-1 ring-inset ring-[var(--workbench-focus)]/40',
      )}
    >
      {indent > 0 && (
        <span className="pointer-events-none absolute inset-y-0 start-3 flex" aria-hidden="true">
          {Array.from({ length: indent }, (_, lane) => {
            const parentLane = lane === indent - 1;
            const continues = parentLane ? hasNextSibling : ancestorGuides.includes(lane);
            return (
              <span key={lane} className="relative w-[var(--session-indent)]">
                {continues && <span className="absolute inset-y-0 start-0 w-px bg-muted-foreground/25" />}
                {parentLane && (
                  <span className={cn(
                    'absolute inset-x-0 top-0 h-[calc(50%+1px)] border-b border-muted-foreground/25',
                    !continues && 'rounded-es-[3px] border-s',
                  )} />
                )}
              </span>
            );
          })}
        </span>
      )}
      {expanded === undefined ? <span className="w-4 shrink-0" aria-hidden="true" /> : (
        <button
          type="button"
          className={cn(
            'relative grid w-4 shrink-0 place-items-center self-stretch rounded-sm text-muted-foreground hover:bg-background/50 hover:text-foreground focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring',
            expanded && depth < SESSION_TREE_INDENT_LIMIT && 'after:pointer-events-none after:absolute after:bottom-0 after:start-1/2 after:top-[calc(50%+6px)] after:w-px after:bg-muted-foreground/25',
          )}
          aria-expanded={expanded}
          aria-label={t(expanded ? 'chat:sidebar.collapseChildren' : 'chat:sidebar.expandChildren', { title: s.title })}
          onClick={event => { event.stopPropagation(); onToggleBranch(s.id); }}
        >
          {expanded ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
        </button>
      )}
      {selectMode ? (
        <span className="grid size-4 shrink-0 place-items-center" aria-hidden="true">
          {checked ? (
            <CheckSquare className="h-3.5 w-3.5 text-primary" />
          ) : (
            <Square className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </span>
      ) : (
        <span className="relative grid size-4 shrink-0 place-items-center" aria-hidden="true">
          <span className={cn('absolute inset-0 rounded-[3px] opacity-25', providerAccent(s.provider))} />
          <span className="relative text-[8px] font-semibold uppercase leading-none text-foreground">
            {s.provider.slice(0, 2)}
          </span>
          {accent && (
            <span
              className="absolute -bottom-px -end-px size-1.5 rounded-full ring-1 ring-card"
              style={{ backgroundColor: accent.solid }}
              aria-hidden="true"
            />
          )}
          {running && (
            <span className="absolute -end-px -top-px size-1.5 animate-pulse rounded-full bg-success ring-1 ring-card motion-reduce:animate-none" />
          )}
        </span>
      )}

      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center rounded-sm text-start text-[length:var(--ide-tree-font)] font-medium text-foreground focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring"
        title={[s.title, ...details].join('\n')}
        aria-description={details.join('. ')}
        aria-current={isActive ? 'page' : undefined}
        aria-pressed={selectMode ? checked : undefined}
      >
        <span className="truncate">{s.title}</span>
      </button>

      {/* Metadata and actions share a grid cell so buttons never cover the title. */}
      <div className="grid shrink-0 items-center justify-items-end">
        <span className={cn(
          'col-start-1 row-start-1 flex items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground',
          !selectMode && 'group-hover/session:opacity-0 group-focus-within/session:opacity-0 pointer-coarse:opacity-0',
        )} aria-hidden="true">
          {!selectMode && s.is_favorite && <Star className="size-2.5 fill-current text-yellow-600 dark:text-yellow-500" />}
          {tokens > 0 && <span className="hidden @min-[210px]:inline" title={tokenDetails}>{formatTokenCount(tokens)}</span>}
          <span className="hidden @min-[340px]:inline">{updated}</span>
        </span>
        {!selectMode && (
          <div className="pointer-events-none col-start-1 row-start-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/session:pointer-events-auto group-hover/session:opacity-100 group-focus-within/session:pointer-events-auto group-focus-within/session:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100">
            <button
              type="button"
              aria-label={s.is_favorite ? t('chat:sidebar.unfavorite') : t('chat:sidebar.favorite')}
              onClick={(e) => {
                e.stopPropagation();
                onFavorite(s.id, !s.is_favorite);
              }}
              className={cn(
                'inline-flex size-[22px] items-center justify-center rounded-sm transition-colors @max-[205px]:hidden pointer-coarse:size-6',
                s.is_favorite
                  ? 'text-yellow-500 hover:text-yellow-600'
                  : 'text-muted-foreground hover:text-foreground hover:bg-background/60',
              )}
            >
              <Star className={cn('size-3', s.is_favorite && 'fill-current')} />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  aria-label={t('chat:sidebar.sessionActions')}
                  className="inline-flex size-[22px] items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground pointer-coarse:size-6"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem onClick={() => onRename(s.id, s.title)}>
                  <Pencil className="h-3.5 w-3.5" /> {t('chat:sidebar.rename')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onFavorite(s.id, !s.is_favorite)}>
                  <Star
                    className={cn('h-3.5 w-3.5', s.is_favorite && 'fill-current text-yellow-500')}
                  />
                  {s.is_favorite ? t('chat:sidebar.unfavorite') : t('chat:sidebar.favorite')}
                </DropdownMenuItem>
                {onTogglePin && (
                  <DropdownMenuItem onClick={() => onTogglePin(s.id)}>
                    <Pin className="h-3.5 w-3.5" />
                    {pinned ? t('pins:unpin') : t('pins:pin')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => onArchive(s.id, !isArchivedView)}>
                  {isArchivedView ? (
                    <>
                      <ArchiveRestore className="h-3.5 w-3.5" /> {t('chat:sidebar.unarchive')}
                    </>
                  ) : (
                    <>
                      <Archive className="h-3.5 w-3.5" /> {t('chat:sidebar.archive')}
                    </>
                  )}
                </DropdownMenuItem>
                {showGroups && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <FolderPlus className="h-3.5 w-3.5" /> {t('chat:sidebar.moveToGroup')}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onClick={() => onMoveToGroup(s.id, null)}>
                        {t('chat:sidebar.noGroup')}
                      </DropdownMenuItem>
                      {groups.length > 0 && <DropdownMenuSeparator />}
                      {groups.map((g) => (
                        <DropdownMenuItem key={g.id} onClick={() => onMoveToGroup(s.id, g.id)}>
                          {g.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                <DropdownMenuItem onClick={() => onDuplicate(s.id)}>
                  <Copy className="h-3.5 w-3.5" /> {t('chat:sidebar.duplicate')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onDelete(s.id)} className="text-destructive">
                  <Trash2 className="h-3.5 w-3.5" /> {t('common:actions.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
    </div>
  );
});
