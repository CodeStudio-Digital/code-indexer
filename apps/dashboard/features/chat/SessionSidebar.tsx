import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  ArchiveRestore,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderPlus,
  FolderX,
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
import { Input } from '../../components/ui/input.js';
import { ScrollArea } from '../../components/ui/scroll-area.js';
import { Combobox, type ComboboxOption } from '../../components/ui/combobox.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js';
import { cn, formatRelativeTime } from '../../lib/utils.js';
import { PROVIDERS, providerAccent } from './constants.js';
import type {
  CoderSession,
  CoderSessionGroup,
  EnrichedProviderModel,
  ProviderOption,
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
  provider: string;
  setProvider: (p: string) => void;
  model: string;
  setModel: (m: string) => void;
  providerOptions: ProviderOption[];
  currentProviderModels: EnrichedProviderModel[];
  /** Mobile drawer open state. On mobile the sidebar is a slide-in overlay. */
  mobileOpen?: boolean;
  /** Called when the mobile drawer should close (backdrop tap, X button). */
  onMobileClose?: () => void;
}

const UNGROUPED_KEY = '__ungrouped__';

export function SessionSidebar({
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
  provider,
  setProvider,
  model,
  setModel,
  providerOptions,
  currentProviderModels,
  mobileOpen = false,
  onMobileClose,
}: SessionSidebarProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [selectMode, setSelectMode] = useState(false);

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

  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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

  // Build grouped view — keep group sort_order, then ungrouped at the end.
  const grouped = useMemo(() => {
    const list = sessions ?? [];
    const byGroup = new Map<string, CoderSession[]>();
    for (const s of list) {
      const key = s.group_id == null ? UNGROUPED_KEY : String(s.group_id);
      const arr = byGroup.get(key) ?? [];
      arr.push(s);
      byGroup.set(key, arr);
    }
    const ordered: { key: string; group: CoderSessionGroup | null; items: CoderSession[] }[] = [];
    for (const g of groups ?? []) {
      const items = byGroup.get(String(g.id)) ?? [];
      if (items.length > 0) ordered.push({ key: String(g.id), group: g, items });
    }
    const ungrouped = byGroup.get(UNGROUPED_KEY) ?? [];
    if (ungrouped.length > 0) {
      ordered.push({ key: UNGROUPED_KEY, group: null, items: ungrouped });
    }
    return ordered;
  }, [sessions, groups]);

  const selectedCount = selectedIds.size;
  const selectedArray = useMemo(() => Array.from(selectedIds), [selectedIds]);
  const isArchivedView = view === 'archived';

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
          // Desktop (lg+): flush IDE-style column — only a right border, no
          // rounded corners or shadow, no transitions.
          'lg:static lg:inset-auto lg:z-auto lg:w-[280px] lg:max-w-none lg:shrink-0 lg:translate-x-0',
          'lg:rounded-none lg:shadow-none lg:transition-none lg:border-0 lg:border-r',
        )}
      >
      <div className="p-3 border-b space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <MessageSquareCode className="h-4 w-4 text-primary" />
            {t('chat:sidebar.sessions')}
          </h3>
          <div className="flex items-center gap-1">
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
            <Button size="sm" onClick={onNew}>
              <Plus className="h-3.5 w-3.5" /> {t('chat:sidebar.new')}
            </Button>
          </div>
        </div>

        {/* Tabs: active / archived */}
        <div className="grid grid-cols-2 rounded-md border p-0.5 text-xs">
          <button
            type="button"
            onClick={() => onViewChange('active')}
            className={cn(
              'rounded px-2 py-1 transition-colors',
              view === 'active' ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
            )}
          >
            {t('chat:sidebar.active')}
          </button>
          <button
            type="button"
            onClick={() => onViewChange('archived')}
            className={cn(
              'rounded px-2 py-1 transition-colors',
              view === 'archived' ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
            )}
          >
            {t('chat:sidebar.archived')}
          </button>
        </div>

        <Combobox
          value={provider}
          onChange={(v) => {
            setProvider(v);
            setModel('');
          }}
          options={providerOptions.map((p) => ({ value: p.id, label: p.label }))}
          placeholder={t('chat:sidebar.provider')}
          searchPlaceholder={t('chat:sidebar.searchProvider')}
          emptyLabel={t('chat:sidebar.noProvider')}
        />
        {currentProviderModels.length > 0 ? (
          <Combobox
            value={model}
            onChange={setModel}
            options={currentProviderModels.map<ComboboxOption>((m) => ({
              value: m.mode ? `${m.id}::${m.mode}` : m.id,
              label: m.id,
              hint: m.mode,
            }))}
            placeholder={t('chat:sidebar.defaultModel')}
            searchPlaceholder={t('chat:sidebar.searchModel')}
            emptyLabel={t('chat:sidebar.noModel')}
          />
        ) : (
          <Input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={PROVIDERS.find((p) => p.id === provider)?.defaultModel}
            className="h-8 text-xs font-mono"
          />
        )}
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

          {grouped.map(({ key, group, items }) => {
            const collapsed = collapsedGroups.has(key);
            return (
              <div key={key} className="space-y-1">
                <div className="flex items-center gap-1 px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => toggleGroupCollapse(key)}
                    className="flex items-center gap-1 hover:text-foreground transition-colors"
                  >
                    {collapsed ? (
                      <ChevronRight className="h-3 w-3" />
                    ) : (
                      <ChevronDown className="h-3 w-3" />
                    )}
                    <span className="font-semibold">
                      {group ? group.name : t('chat:sidebar.ungrouped')}
                    </span>
                    <span className="text-muted-foreground/60">({items.length})</span>
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
                      onToggle={() => toggleSelected(s.id)}
                      onSelect={() => onSelect(s.id)}
                      onDelete={() => onDelete(s.id)}
                      onRename={() => onRename(s.id, s.title)}
                      onDuplicate={() => onDuplicate(s.id)}
                      onArchive={() => onArchive(s.id, !isArchivedView)}
                      onFavorite={() => onFavorite(s.id, !s.is_favorite)}
                      isArchivedView={isArchivedView}
                      groups={groups ?? []}
                      onMoveToGroup={(gid) => onMoveToGroup(s.id, gid)}
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
}

function SessionRow({
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
}: {
  session: CoderSession;
  selected: boolean;
  selectMode: boolean;
  checked: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onDelete: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  onFavorite: () => void;
  isArchivedView: boolean;
  groups: CoderSessionGroup[];
  onMoveToGroup: (groupId: number | null) => void;
}) {
  const { t } = useTranslation(['chat', 'common']);
  const tokens = s.total_input_tokens + s.total_output_tokens;
  const handleClick = () => {
    if (selectMode) onToggle();
    else onSelect();
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
          >
            {s.provider.slice(0, 2)}
          </div>
        )}
        <div className="flex-1 min-w-0 overflow-hidden">
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="font-medium text-xs truncate">{s.title}</div>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-xs break-words">
              {s.title}
            </TooltipContent>
          </Tooltip>
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
              onFavorite();
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
              <DropdownMenuItem onClick={onRename}>
                <Pencil className="h-3.5 w-3.5" /> {t('chat:sidebar.rename')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onFavorite}>
                <Star
                  className={cn('h-3.5 w-3.5', s.is_favorite && 'fill-current text-yellow-500')}
                />
                {s.is_favorite ? t('chat:sidebar.unfavorite') : t('chat:sidebar.favorite')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onArchive}>
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
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FolderPlus className="h-3.5 w-3.5" /> {t('chat:sidebar.moveToGroup')}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onClick={() => onMoveToGroup(null)}>
                    {t('chat:sidebar.noGroup')}
                  </DropdownMenuItem>
                  {groups.length > 0 && <DropdownMenuSeparator />}
                  {groups.map((g) => (
                    <DropdownMenuItem key={g.id} onClick={() => onMoveToGroup(g.id)}>
                      {g.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem onClick={onDuplicate}>
                <Copy className="h-3.5 w-3.5" /> {t('chat:sidebar.duplicate')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onDelete} className="text-destructive">
                <Trash2 className="h-3.5 w-3.5" /> {t('common:actions.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
