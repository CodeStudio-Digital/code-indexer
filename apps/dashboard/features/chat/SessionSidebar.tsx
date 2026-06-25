import { memo, useCallback, useEffect, useMemo, useState } from 'react';
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
  Inbox,
  MessageSquareCode,
  MoreHorizontal,
  Pencil,
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
import { providerAccent, workspaceColor, type AccentColor } from './constants.js';
import type {
  CoderSession,
  CoderSessionGroup,
} from './types.js';

export type SessionView = 'active' | 'archived';

interface SessionSidebarProps {
  sessions: CoderSession[] | null;
  groups: CoderSessionGroup[] | null;
  selectedId: number | null;
  view: SessionView;
  onViewChange: (view: SessionView) => void;
  onSelect: (id: number) => void;
  onNew: () => void;
  onDelete: (id: number) => void;
  onRename: (id: number, currentTitle: string) => void;
  onDuplicate: (id: number) => Promise<void> | void;
  onBatchDelete: (ids: number[]) => Promise<void> | void;
  onDeleteAll: () => Promise<void> | void;
  onArchive: (id: number, archived: boolean) => Promise<void> | void;
  onFavorite: (id: number, favorite: boolean) => Promise<void> | void;
  onBatchArchive: (ids: number[], archived: boolean) => Promise<void> | void;
  onMoveToGroup: (id: number, groupId: number | null) => Promise<void> | void;
  onBatchMoveToGroup: (ids: number[], groupId: number | null) => Promise<void> | void;
  onCreateGroup: () => void;
  onRenameGroup: (group: CoderSessionGroup) => void;
  onDeleteGroup: (group: CoderSessionGroup) => void;
  projectName: string;
  /**
   * How to bucket the list. `'group'` (default) — the per-project named folders
   * (`group_id`). `'workspace'` — Sessões Globais: auto-group by the virtual
   * workspace (`project_id`, the synthetic union), header = `workspace_label`,
   * each workspace gets a stable accent color. Manual-group controls are hidden
   * in `'workspace'` mode (groups are per-project).
   */
  groupBy?: 'group' | 'workspace';
  /** Mobile drawer open state. On mobile the sidebar is a slide-in overlay. */
  mobileOpen?: boolean;
  /** Called when the mobile drawer should close (backdrop tap, X button). */
  onMobileClose?: () => void;
}

const UNGROUPED_KEY = '__ungrouped__';

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
  onDelete,
  onRename,
  onDuplicate,
  onBatchDelete,
  onDeleteAll,
  onArchive,
  onFavorite,
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
}: SessionSidebarProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [selectMode, setSelectMode] = useState(false);
  // Workspace mode (Sessões Globais) auto-buckets by virtual workspace; the
  // per-project named-folder controls don't apply there.
  const showGroups = groupBy === 'group';

  // Close the drawer on Escape so mobile users aren't trapped.
  useEffect(() => {
    if (!mobileOpen || !onMobileClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onMobileClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, onMobileClose]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Stable so `memo(SessionRow)` isn't defeated — passed straight to every row.
  const toggleSelected = useCallback((id: number) => {
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
    const list = sessions ?? [];

    // Sessões Globais: bucket by the virtual workspace (synthetic project_id),
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
  }, [sessions, groups, groupBy]);

  const selectedCount = selectedIds.size;
  const selectedArray = useMemo(() => Array.from(selectedIds), [selectedIds]);
  const isArchivedView = view === 'archived';
  // Stable array identity for the rows' move-to-group submenu (was `groups ?? []`
  // recreated inline per render, which defeated the row memo).
  const rowGroups = useMemo(() => groups ?? [], [groups]);

  return (
    <>
      {/* Mobile backdrop — only visible below lg when the drawer is open. */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-background/80 backdrop-blur-sm z-40 lg:hidden"
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={cn(
          'flex flex-col bg-card overflow-hidden',
          // Mobile: fixed slide-in drawer from the left.
          'fixed inset-y-0 left-0 z-50 w-[85%] max-w-[320px] rounded-r-xl shadow-2xl border',
          'transition-transform duration-200 ease-out',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          // Desktop (lg+): fill the host `<Panel>` from react-resizable-panels.
          // Width is owned by the panel — we just expand to it. The right
          // border still belongs to us (not to the panel) so the resize
          // handle stays visually attached to the divider.
          'lg:static lg:inset-auto lg:z-auto lg:w-full lg:h-full lg:max-w-none lg:translate-x-0',
          'lg:rounded-none lg:shadow-none lg:transition-none lg:border-0 lg:border-r',
        )}
      >
      {/* Thin single-row header — matches the system's section strips
          (icon + compact title on the left, action icons on the right). */}
      <div className="flex items-center gap-1 border-b px-2 h-9">
        <div className="flex min-w-0 items-center gap-1.5">
          <MessageSquareCode className="h-4 w-4 text-primary shrink-0" />
          <span className="text-xs font-semibold truncate">{t('chat:sidebar.sessions')}</span>
        </div>
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
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
          {onMobileClose && (
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={onNew}
                aria-label={t('chat:sidebar.new')}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('chat:sidebar.new')}</TooltipContent>
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
        <div className="p-2 space-y-2">
          {sessions?.length === 0 && (
            <div className="p-4 text-xs text-muted-foreground text-center">
              {isArchivedView
                ? t('chat:sidebar.noArchived', { name: projectName })
                : t('chat:sidebar.noSessions', { name: projectName })}
            </div>
          )}

          {grouped.map(({ key, group, items, label, accent }) => {
            const collapsed = collapsedGroups.has(key);
            const headerLabel = label ?? (group ? group.name : t('chat:sidebar.ungrouped'));
            return (
              <div key={key} className="space-y-1">
                <div className="flex items-center gap-1 px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => toggleGroupCollapse(key)}
                    className="flex min-w-0 items-center gap-1 hover:text-foreground transition-colors"
                  >
                    {collapsed ? (
                      <ChevronRight className="h-3 w-3 shrink-0" />
                    ) : (
                      <ChevronDown className="h-3 w-3 shrink-0" />
                    )}
                    {accent && (
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: accent.solid }}
                        aria-hidden="true"
                      />
                    )}
                    <span className="font-semibold truncate normal-case" title={headerLabel}>
                      {headerLabel}
                    </span>
                    <span className="text-muted-foreground/60 shrink-0">({items.length})</span>
                  </button>
                  {group && (
                    <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
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
                      isArchivedView={isArchivedView}
                      groups={rowGroups}
                      onMoveToGroup={onMoveToGroup}
                      showGroups={showGroups}
                      accent={accent}
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
  isArchivedView,
  groups,
  onMoveToGroup,
  showGroups,
  accent,
}: {
  session: CoderSession;
  selected: boolean;
  selectMode: boolean;
  checked: boolean;
  // Stable parent callbacks (id-taking) — the row binds its own session.id, so
  // the parent never allocates a per-row closure and the memo holds.
  onToggle: (id: number) => void;
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
  onRename: (id: number, currentTitle: string) => void;
  onDuplicate: (id: number) => Promise<void> | void;
  onArchive: (id: number, archived: boolean) => Promise<void> | void;
  onFavorite: (id: number, favorite: boolean) => Promise<void> | void;
  isArchivedView: boolean;
  groups: CoderSessionGroup[];
  onMoveToGroup: (id: number, groupId: number | null) => Promise<void> | void;
  /** Per-project named groups don't apply in global (workspace) mode. */
  showGroups: boolean;
  /** Workspace accent — paints a ring on the avatar so a session visually ties
   *  to its group header (and the chat header bar). Undefined = no ring. */
  accent?: AccentColor;
}) {
  const { t } = useTranslation(['chat', 'common']);
  const tokens = s.total_input_tokens + s.total_output_tokens;
  const handleClick = () => {
    if (selectMode) onToggle(s.id);
    else onSelect(s.id);
  };
  return (
    <div
      onClick={handleClick}
      className={cn(
        'group rounded-lg px-2.5 py-2 cursor-pointer transition-colors',
        selected && !selectMode ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
        selectMode && checked && 'ring-1 ring-primary bg-accent/60',
      )}
    >
      <div className="flex items-start gap-2 min-w-0">
        {selectMode ? (
          <div className="h-7 w-7 flex items-center justify-center shrink-0 mt-0.5">
            {checked ? (
              <CheckSquare className="h-4 w-4 text-primary" />
            ) : (
              <Square className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        ) : (
          <div
            className={cn(
              'h-7 w-7 rounded-md flex items-center justify-center text-white text-[10px] font-bold uppercase shrink-0 mt-0.5',
              providerAccent(s.provider),
            )}
            style={accent ? { boxShadow: `0 0 0 2px ${accent.solid}` } : undefined}
          >
            {s.provider.slice(0, 2)}
          </div>
        )}
        <div className="flex-1 min-w-0 overflow-hidden">
          {/* Native title (was a per-row Radix Tooltip wrapping the static
              title) — removes N tooltip providers/portals from a long list. */}
          <div className="font-medium text-xs truncate" title={s.title}>
            {s.title}
          </div>
          <div className="text-[10px] text-muted-foreground truncate font-mono mt-0.5">{s.model}</div>
          <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1.5">
            <span className="tabular-nums">{tokens.toLocaleString()} tok</span>
            <span>·</span>
            <span>{formatRelativeTime(s.updated_at)}</span>
          </div>
        </div>
        {!selectMode && (
          <button
            type="button"
            aria-label={s.is_favorite ? t('chat:sidebar.unfavorite') : t('chat:sidebar.favorite')}
            onClick={(e) => {
              e.stopPropagation();
              onFavorite(s.id, !s.is_favorite);
            }}
            className={cn(
              'shrink-0 rounded p-1 transition-colors',
              s.is_favorite
                ? 'text-yellow-500 hover:text-yellow-600'
                : 'text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-background/60',
            )}
          >
            <Star className={cn('h-3.5 w-3.5', s.is_favorite && 'fill-current')} />
          </button>
        )}
        {!selectMode && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <button
                aria-label={t('chat:sidebar.sessionActions')}
                className="shrink-0 text-muted-foreground hover:text-foreground hover:bg-background/60 rounded p-1 transition-colors"
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
        )}
      </div>
    </div>
  );
});
