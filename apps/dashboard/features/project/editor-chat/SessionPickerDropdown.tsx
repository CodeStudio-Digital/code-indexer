/**
 * Compact sessions list shown in rails before a session is open. Sessions are
 * shared with the full Chat tab, but this surface keeps the controls dense:
 * grouped sections, favorite/archive/delete actions, and a right-click menu.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  Copy,
  Folder,
  FolderInput,
  Inbox,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Star,
  Trash2,
} from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu.js';
import { useContextMenu, type ContextMenuItem } from '../../../components/ui/context-menu.js';
import { cn, formatRelativeTime } from '../../../lib/utils.js';
import type { CoderSession, CoderSessionGroup } from '../../chat/types.js';

interface Props {
  projectName: string;
  sessions: CoderSession[] | null;
  groups?: CoderSessionGroup[] | null;
  onPick: (id: string) => void;
  onFavorite?: (id: string, favorite: boolean) => Promise<void> | void;
  onArchive?: (id: string) => Promise<void> | void;
  onDelete?: (id: string) => Promise<void> | void;
  onRename?: (id: string, currentTitle: string) => Promise<void> | void;
  onDuplicate?: (id: string) => Promise<unknown> | void;
  onMoveToGroup?: (id: string, groupId: number | null) => Promise<void> | void;
}

interface SessionSection {
  key: string;
  label: string;
  items: CoderSession[];
}

function tokenCount(s: CoderSession): number {
  return (
    (s.total_input_tokens ?? 0) +
    (s.total_output_tokens ?? 0) +
    (s.total_cache_read_tokens ?? 0) +
    (s.total_cache_creation_tokens ?? 0)
  );
}

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function sortSessions(list: CoderSession[]): CoderSession[] {
  return list.slice().sort((a, b) => {
    if (a.is_favorite !== b.is_favorite) return a.is_favorite ? -1 : 1;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });
}

export function SessionPickerDropdown({
  projectName,
  sessions,
  groups,
  onPick,
  onFavorite,
  onArchive,
  onDelete,
  onRename,
  onDuplicate,
  onMoveToGroup,
}: Props) {
  const { t } = useTranslation(['workspace', 'chat', 'common']);
  const list = sessions ?? [];
  const sections = useMemo<SessionSection[]>(() => {
    if (!list.length) return [];
    const namedGroups = groups ?? [];
    if (namedGroups.length > 0) {
      const byGroup = new Map<string, CoderSession[]>();
      for (const s of list) {
        const key = s.group_id == null ? '__ungrouped__' : String(s.group_id);
        byGroup.set(key, [...(byGroup.get(key) ?? []), s]);
      }
      const ordered: SessionSection[] = [];
      for (const g of namedGroups) {
        const items = byGroup.get(String(g.id));
        if (items?.length) ordered.push({ key: String(g.id), label: g.name, items: sortSessions(items) });
      }
      const ungrouped = byGroup.get('__ungrouped__');
      if (ungrouped?.length) {
        ordered.push({
          key: '__ungrouped__',
          label: t('chat:sidebar.ungrouped', { defaultValue: 'Desagrupadas' }),
          items: sortSessions(ungrouped),
        });
      }
      return ordered;
    }

    const favorites = list.filter((s) => s.is_favorite);
    const recent = list.filter((s) => !s.is_favorite);
    return [
      favorites.length
        ? {
            key: '__favorites__',
            label: t('chat:sidebar.favorites', { defaultValue: 'Favoritas' }),
            items: sortSessions(favorites),
          }
        : null,
      recent.length
        ? {
            key: '__recent__',
            label: t('chat:sidebar.recent', { defaultValue: 'Recentes' }),
            items: sortSessions(recent),
          }
        : null,
    ].filter(Boolean) as SessionSection[];
  }, [groups, list, t]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {list.length === 0 ? (
          <div className="grid place-items-center gap-2.5 px-3 py-8 text-center">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10">
              <Inbox className="h-4 w-4 text-primary/70" />
            </div>
            <div>
              <p className="text-[12px] font-medium text-foreground">{t('workspace:chat.empty.activeTitle')}</p>
              <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                {t('workspace:chat.empty.activeDescription', { projectName })}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {sections.map((section) => (
              <section key={section.key} className="space-y-1">
                <div className="flex items-center gap-1.5 px-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  <Folder className="h-3 w-3" />
                  <span className="min-w-0 flex-1 truncate">{section.label}</span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[9px]">{section.items.length}</span>
                </div>
                <div className="space-y-1">
                  {section.items.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      groups={groups ?? []}
                      onPick={onPick}
                      onFavorite={onFavorite}
                      onArchive={onArchive}
                      onDelete={onDelete}
                      onRename={onRename}
                      onDuplicate={onDuplicate}
                      onMoveToGroup={onMoveToGroup}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  groups,
  onPick,
  onFavorite,
  onArchive,
  onDelete,
  onRename,
  onDuplicate,
  onMoveToGroup,
}: {
  session: CoderSession;
  groups: CoderSessionGroup[];
  onPick: (id: string) => void;
  onFavorite?: (id: string, favorite: boolean) => Promise<void> | void;
  onArchive?: (id: string) => Promise<void> | void;
  onDelete?: (id: string) => Promise<void> | void;
  onRename?: (id: string, currentTitle: string) => Promise<void> | void;
  onDuplicate?: (id: string) => Promise<unknown> | void;
  onMoveToGroup?: (id: string, groupId: number | null) => Promise<void> | void;
}) {
  const { t } = useTranslation(['chat', 'common']);
  const hasActions = Boolean(onFavorite || onArchive || onDelete || onRename || onDuplicate || onMoveToGroup);
  const menuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = [];
    if (onRename) {
      items.push({
        id: 'rename',
        label: t('chat:sidebar.rename'),
        icon: Pencil,
        onSelect: () => void onRename(session.id, session.title),
      });
    }
    if (onFavorite) {
      items.push({
        id: 'favorite',
        label: session.is_favorite ? t('chat:sidebar.unfavorite') : t('chat:sidebar.favorite'),
        icon: Star,
        onSelect: () => void onFavorite(session.id, !session.is_favorite),
      });
    }
    if (onDuplicate) {
      items.push({
        id: 'duplicate',
        label: t('chat:sidebar.duplicate'),
        icon: Copy,
        onSelect: () => void onDuplicate(session.id),
      });
    }
    if (onMoveToGroup) {
      items.push({
        id: 'move',
        label: t('chat:sidebar.moveToGroup'),
        icon: FolderInput,
        submenu: [
          {
            id: 'move-none',
            label: t('chat:sidebar.noGroup'),
            onSelect: () => void onMoveToGroup(session.id, null),
          },
          ...groups.map((g) => ({
            id: `move-${g.id}`,
            label: g.name,
            onSelect: () => void onMoveToGroup(session.id, g.id),
          })),
        ],
      });
    }
    if (onArchive) {
      items.push({
        id: 'archive',
        label: t('chat:sidebar.archive'),
        icon: Archive,
        onSelect: () => void onArchive(session.id),
      });
    }
    if (onDelete) {
      items.push({
        id: 'delete',
        label: t('common:actions.delete'),
        icon: Trash2,
        destructive: true,
        separatorBefore: items.length > 0,
        onSelect: () => void onDelete(session.id),
      });
    }
    return items;
  }, [groups, onArchive, onDelete, onDuplicate, onFavorite, onMoveToGroup, onRename, session, t]);
  const contextMenu = useContextMenu(menuItems);
  const tokens = tokenCount(session);
  const meta = `${session.model || session.provider || 'model'} · ${formatRelativeTime(session.updated_at)}`;

  return (
    <>
      <div
        {...(hasActions ? contextMenu.triggerProps : {})}
        role="button"
        tabIndex={0}
        onClick={() => onPick(session.id)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          onPick(session.id);
        }}
        className="group relative flex min-h-12 cursor-pointer items-center gap-2 rounded-md border border-transparent bg-background/30 px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      >
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          <MessageSquare className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground" title={session.title}>
              {session.title}
            </span>
            {session.is_favorite && <Star className="h-3 w-3 shrink-0 fill-current text-yellow-500" />}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <span className="min-w-0 truncate">{meta}</span>
            {tokens > 0 && (
              <>
                <span className="shrink-0 text-muted-foreground/40">·</span>
                <span className="shrink-0">{t('chat:sessionPicker.tokens', { count: compactNumber(tokens) })}</span>
              </>
            )}
          </div>
        </div>
        {hasActions && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {onFavorite && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void onFavorite(session.id, !session.is_favorite);
                }}
                className={cn(
                  'grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground',
                  session.is_favorite && 'text-yellow-500',
                )}
                aria-label={session.is_favorite ? t('chat:sidebar.unfavorite') : t('chat:sidebar.favorite')}
              >
                <Star className={cn('h-3.5 w-3.5', session.is_favorite && 'fill-current')} />
              </button>
            )}
            <SessionActionsMenu
              session={session}
              groups={groups}
              onArchive={onArchive}
              onDelete={onDelete}
              onFavorite={onFavorite}
              onRename={onRename}
              onDuplicate={onDuplicate}
              onMoveToGroup={onMoveToGroup}
            />
          </div>
        )}
      </div>
      {hasActions && contextMenu.Menu}
    </>
  );
}

function SessionActionsMenu({
  session,
  groups,
  onFavorite,
  onArchive,
  onDelete,
  onRename,
  onDuplicate,
  onMoveToGroup,
}: {
  session: CoderSession;
  groups: CoderSessionGroup[];
  onFavorite?: (id: string, favorite: boolean) => Promise<void> | void;
  onArchive?: (id: string) => Promise<void> | void;
  onDelete?: (id: string) => Promise<void> | void;
  onRename?: (id: string, currentTitle: string) => Promise<void> | void;
  onDuplicate?: (id: string) => Promise<unknown> | void;
  onMoveToGroup?: (id: string, groupId: number | null) => Promise<void> | void;
}) {
  const { t } = useTranslation(['chat', 'common']);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          aria-label={t('chat:sidebar.sessionActions')}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
        {onRename && (
          <DropdownMenuItem onClick={() => void onRename(session.id, session.title)}>
            <Pencil className="h-3.5 w-3.5" />
            {t('chat:sidebar.rename')}
          </DropdownMenuItem>
        )}
        {onFavorite && (
          <DropdownMenuItem onClick={() => void onFavorite(session.id, !session.is_favorite)}>
            <Star className={cn('h-3.5 w-3.5', session.is_favorite && 'fill-current text-yellow-500')} />
            {session.is_favorite ? t('chat:sidebar.unfavorite') : t('chat:sidebar.favorite')}
          </DropdownMenuItem>
        )}
        {onDuplicate && (
          <DropdownMenuItem onClick={() => void onDuplicate(session.id)}>
            <Copy className="h-3.5 w-3.5" />
            {t('chat:sidebar.duplicate')}
          </DropdownMenuItem>
        )}
        {onMoveToGroup && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderInput className="h-3.5 w-3.5" />
              {t('chat:sidebar.moveToGroup')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => void onMoveToGroup(session.id, null)}>
                {t('chat:sidebar.noGroup')}
              </DropdownMenuItem>
              {groups.length > 0 && <DropdownMenuSeparator />}
              {groups.map((g) => (
                <DropdownMenuItem key={g.id} onClick={() => void onMoveToGroup(session.id, g.id)}>
                  {g.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {onArchive && (
          <DropdownMenuItem onClick={() => void onArchive(session.id)}>
            <Archive className="h-3.5 w-3.5" />
            {t('chat:sidebar.archive')}
          </DropdownMenuItem>
        )}
        {onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onClick={() => void onDelete(session.id)}>
              <Trash2 className="h-3.5 w-3.5" />
              {t('common:actions.delete')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
