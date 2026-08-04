import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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
import {
  getActiveAgentSessionIdsSnapshot,
  subscribeActiveAgentSessions,
} from '../../hooks/agent-stream/session-stream-store.js';
import { providerAccent, workspaceColor, type AccentColor } from './constants.js';
import type {
  CoderSession,
  CoderSessionGroup,
} from './types.js';

export type SessionView = 'active' | 'archived';

interface SessionSidebarProps {
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
const EXECUTING_SESSION_STATUSES = new Set(['running', 'in_progress', 'working']);

export function isExecutingSessionStatus(status: string): boolean {
  return EXECUTING_SESSION_STATUSES.has(status.trim().toLowerCase());
}

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
  const liveSessionIdList = useSyncExternalStore(
    subscribeActiveAgentSessions,
    getActiveAgentSessionIdsSnapshot,
    getActiveAgentSessionIdsSnapshot,
  );
  const executingSessionIds = useMemo(() => {
    const ids = new Set<string>(liveSessionIdList);
    for (const session of sessions ?? []) {
      if (isExecutingSessionStatus(session.status)) ids.add(session.id);
    }
    return ids;
  }, [liveSessionIdList, sessions]);
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
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

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
    items: CoderSession[];
    label?: string;
    accent?: AccentColor;
  };
  const grouped = useMemo<GroupEntry[]>(() => {
    const list = (sessions ?? []).filter(
      (session) => !runningOnly || executingSessionIds.has(session.id),
    );

    // Sessões Globais: bucket by their primary real project,
    // in first-appearance order (the list is already sorted by favorite+recency).
    if (groupBy === 'workspace') {
      const byWs = new Map<string, CoderSession[]>();
      const order: string[] = [];
      for (const s of list) {
        const key = String(s.project_id);
        if (!byWs.has(key)) { byWs.set(key, []); order.push(key); }
        byWs.get(key)!.push(s);
      }
      return order.map((key) => {
        const items = byWs.get(key)!;
        const head = items[0];
        return {
          key,
          group: null,
          items,
          label: head.workspace_label || head.project_name || head.title,
          accent: workspaceColor(head.project_id),
        };
      });
    }

    // Per-project: keep group sort_order, then ungrouped at the end.
    const byGroup = new Map<string, CoderSession[]>();
    for (const s of list) {
      const key = s.group_id == null ? UNGROUPED_KEY : String(s.group_id);
      const arr = byGroup.get(key) ?? [];
      arr.push(s);
      byGroup.set(key, arr);
    }
    const ordered: GroupEntry[] = [];
    for (const g of groups ?? []) {
      const items = byGroup.get(String(g.id)) ?? [];
      if (items.length > 0) ordered.push({ key: String(g.id), group: g, items });
    }
    const ungrouped = byGroup.get(UNGROUPED_KEY) ?? [];
    if (ungrouped.length > 0) {
      ordered.push({ key: UNGROUPED_KEY, group: null, items: ungrouped });
    }
    return ordered;
  }, [sessions, groups, groupBy, runningOnly, executingSessionIds]);

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
      {/* Thin single-row header — matches the system's section strips
          (icon + compact title on the left, action icons on the right). */}
      <div className="flex items-center gap-1 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-2 h-9">
        <div className="flex min-w-0 items-center gap-1.5">
          <MessageSquareCode className="h-4 w-4 text-primary shrink-0" />
          {/* Some quando a barra aperta — sobra o ícone + as ações. */}
          <span className="text-xs font-semibold truncate @max-[180px]:hidden">{t('chat:sidebar.sessions')}</span>
        </div>
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
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
                disabled={creating}
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
        <div className="px-1.5 py-2 space-y-3">
          {((sessions?.length === 0) || (runningOnly && runningCount === 0)) && (
            <div className="p-4 text-xs text-muted-foreground text-center">
              {runningOnly
                ? t('chat:sidebar.noRunning')
                : isArchivedView
                ? t('chat:sidebar.noArchived', { name: projectName })
                : t('chat:sidebar.noSessions', { name: projectName })}
            </div>
          )}

          {grouped.map(({ key, group, items, label, accent }) => {
            const collapsed = collapsedGroups.has(key);
            const headerLabel = label ?? (group ? group.name : t('chat:sidebar.ungrouped'));
            return (
              <div key={key} className="space-y-0.5">
                <div className="group/hdr flex items-center gap-1.5 px-1.5 h-6 text-[10px] uppercase tracking-[0.08em] text-muted-foreground/70">
                  <button
                    type="button"
                    onClick={() => toggleGroupCollapse(key)}
                    className="flex min-w-0 items-center gap-1.5"
                  >
                    {collapsed ? (
                      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                    ) : (
                      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                    )}
                    {accent && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: accent.solid }}
                        aria-hidden="true"
                      />
                    )}
                    <span
                      className="font-semibold truncate normal-case tracking-normal text-muted-foreground/90 group-hover/hdr:text-foreground transition-colors"
                      title={headerLabel}
                    >
                      {headerLabel}
                    </span>
                    <span className="shrink-0 ml-1 font-mono tabular-nums text-muted-foreground/45">
                      {items.length}
                    </span>
                  </button>
                  {group && (
                    <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover/hdr:opacity-100 transition-opacity">
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
                {!collapsed &&
                  items.map((s) => (
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
  /** Workspace accent — paints a ring on the avatar so a session visually ties
   *  to its group header (and the chat header bar). Undefined = no ring. */
  accent?: AccentColor;
  /** Authoritative persisted status combined with the renderer's live transport registry. */
  running: boolean;
}) {
  const { t } = useTranslation(['chat', 'common']);
  const pinId = sessionPinId?.(s.id);
  const pinned = usePinnedTabs((st) => (pinId ? st.pins.some((p) => p.id === pinId) : false));
  const tokens = s.total_input_tokens + s.total_output_tokens;
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
      data-session-running={running ? 'true' : 'false'}
      onClick={handleClick}
      className={cn(
        // Two-line row. The 2px left accent rule is a `before:` pseudo-element
        // (transparent at rest) — a quiet edge marker instead of a heavy fill,
        // and GPU-cheap (no per-row shadow) across a long list.
        'group relative flex items-center gap-2 min-w-0 rounded-md pl-3 pr-2 py-1.5 cursor-pointer transition-colors',
        "before:content-[''] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-transparent before:transition-colors",
        !isActive && !isChecked && 'hover:bg-muted/50',
        isActive && 'bg-[var(--workbench-active)] before:bg-[var(--workbench-focus)] hover:bg-[var(--workbench-active)]',
        isChecked && 'bg-[var(--workbench-active)] before:bg-[var(--workbench-focus)] ring-1 ring-inset ring-[var(--workbench-focus)]/40',
      )}
    >
      {selectMode ? (
        <div className="h-6 w-6 flex items-center justify-center shrink-0">
          {checked ? (
            <CheckSquare className="h-3.5 w-3.5 text-primary" />
          ) : (
            <Square className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </div>
      ) : (
        <div className="relative shrink-0">
          <div
            className={cn(
              // Lit-from-above avatar: inner hairline ring + 1px top highlight.
              'h-6 w-6 rounded-[5px] flex items-center justify-center text-white text-[9px] font-bold uppercase tracking-tight tabular-nums ring-1 ring-inset ring-white/10 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)]',
              providerAccent(s.provider),
            )}
          >
            {s.provider.slice(0, 2)}
          </div>
          {/* Workspace presence dot — ties the session to its group/header
              without the old chunky 2px ring stealing avatar width. */}
          {accent && (
            <span
              className="absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-2 ring-card"
              style={{ backgroundColor: accent.solid }}
              aria-hidden="true"
            />
          )}
          {running && (
            <span
              className="absolute -top-0.5 -right-0.5 flex h-2 w-2 items-center justify-center"
              aria-hidden="true"
            >
              <span className="absolute h-full w-full rounded-full bg-emerald-400/50 animate-ping motion-reduce:animate-none" />
              <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-400 ring-2 ring-card" />
            </span>
          )}
        </div>
      )}

      {/* `title` no wrapper carrega model · tempo · tokens para quando a
          barra aperta e a linha 2 / o badge somem (container queries). */}
      <div
        className="flex-1 min-w-0 flex flex-col"
        title={`${running ? `${t('chat:sidebar.running')} · ` : ''}${s.model} · ${formatRelativeTime(s.updated_at)} · ${tokens.toLocaleString()} tokens`}
      >
        {/* Line 1: title + right-floated token figure (Linear-style numerals).
            Native title carries the exact count; the row shows it compacted. */}
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="font-medium text-[11px] leading-tight truncate text-foreground/95 group-hover:text-foreground"
            title={s.title}
          >
            {s.title}
          </span>
          {/* Tokens fade out on hover so the action cluster can take their
              place — no overlap / bleed-through. Some quando a barra aperta
              (< ~170px) — o número vai para o tooltip do wrapper. */}
          <span className="ml-auto flex items-center gap-1 shrink-0 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 @max-[170px]:hidden">
            {!selectMode && s.is_favorite && (
              <Star className="h-3 w-3 fill-current text-yellow-500" aria-hidden="true" />
            )}
            <span
              className="font-mono text-[10px] tabular-nums text-muted-foreground/70 tracking-tight"
              title={`${tokens.toLocaleString()} tokens`}
            >
              {formatTokenCount(tokens)}
              <span className="text-muted-foreground/40"> tok</span>
            </span>
          </span>
        </div>
        {/* Line 2: model · relative time, all mono so it reads as metadata.
            Colapsa a barra para 1 linha (título só) abaixo de ~210px. */}
        <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground tabular-nums min-w-0 @max-[210px]:hidden">
          {running && (
            <span className="inline-flex shrink-0 items-center gap-1 font-sans font-medium text-emerald-400">
              <Loader2 className="h-2.5 w-2.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              {t('chat:sidebar.running')}
            </span>
          )}
          {s.import_source && (
            <span className="shrink-0 rounded border px-1 text-[9px] uppercase tracking-wide text-primary/80">
              {s.import_source === 'claude-code' ? 'Claude' : 'Codex'}
            </span>
          )}
          {running && <span className="text-muted-foreground/40 shrink-0">·</span>}
          <span className="text-muted-foreground/80 truncate min-w-0">{s.model}</span>
          <span className="text-muted-foreground/40 shrink-0">·</span>
          <span className="shrink-0">{formatRelativeTime(s.updated_at)}</span>
        </div>
      </div>

      {/* Hover actions sit where the (now hidden) token figure was — no
          gradient/overlay, so nothing bleeds through behind the icons. */}
      {!selectMode && (
        <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            type="button"
            aria-label={s.is_favorite ? t('chat:sidebar.unfavorite') : t('chat:sidebar.favorite')}
            onClick={(e) => {
              e.stopPropagation();
              onFavorite(s.id, !s.is_favorite);
            }}
            className={cn(
              'inline-flex h-5 w-5 items-center justify-center rounded transition-colors',
              s.is_favorite
                ? 'text-yellow-500 hover:text-yellow-600'
                : 'text-muted-foreground hover:text-foreground hover:bg-background/60',
            )}
          >
            <Star className={cn('h-3.5 w-3.5', s.is_favorite && 'fill-current')} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <button
                aria-label={t('chat:sidebar.sessionActions')}
                className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
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
  );
});
