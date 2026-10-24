import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, FolderPlus, LayoutGrid, LayoutList, Plus, Search, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { Badge } from '../../../components/ui/badge.js';
import { Button } from '../../../components/ui/button.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../../../components/ui/dropdown-menu.js';
import { Input } from '../../../components/ui/input.js';
import { cn } from '../../../lib/utils.js';
import type { ProjectCardData } from './project-card-types.js';
import { UNGROUPED_PROJECTS_KEY, type ProjectListFilter } from './projectListModel.js';
interface Props {
  projects: ProjectCardData[];
  statusCounts: { indexed: number; notIndexed: number };
  setScaffolding: (open: boolean) => void;
  setCreating: (open: boolean) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  filter: ProjectListFilter;
  setFilter: (filter: ProjectListFilter) => void;
  grouped: boolean;
  setGrouped: Dispatch<SetStateAction<boolean>>;
  layout: 'cards' | 'compact';
  setLayout: (layout: 'cards' | 'compact') => void;
  navigationGroups: Map<string, ProjectCardData[]>;
  selectedGroup: string | null;
  setSelectedGroup: (group: string | null) => void;
}
export function ProjectListNavigation({ projects, statusCounts, setScaffolding, setCreating, searchInputRef, searchQuery, setSearchQuery, filter, setFilter, grouped, setGrouped, layout, setLayout, navigationGroups, selectedGroup, setSelectedGroup }: Props) {
  const { t } = useTranslation(['projects', 'common']);
  return (
      <aside className="min-w-0 rounded-xl border bg-card/30 p-3 lg:sticky lg:top-0 lg:max-h-[calc(100vh-5rem)] lg:overflow-y-auto">
        <div className="space-y-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold tracking-tight">{t('projects:title')}</h2>
              <Badge variant="muted" className="normal-case tracking-normal">
                {projects.length}
              </Badge>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t('projects:indexSummary', {
                indexed: statusCounts.indexed,
                total: projects.length,
              })}
            </p>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="w-full justify-start">
                <Plus className="h-4 w-4" />
                <span className="flex-1 text-left">{t('projects:addProject')}</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem onSelect={() => setScaffolding(true)}>
                <Sparkles className="h-4 w-4" />
                {t('projects:newProject')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setCreating(true)}>
                <FolderPlus className="h-4 w-4" />
                {t('projects:registerExisting')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t('projects:searchPlaceholderDetailed')}
              className="h-9 w-full pl-9 pr-10 text-sm"
              aria-label={t('projects:searchPlaceholderDetailed')}
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                aria-label={t('projects:clearSearch')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                /
              </kbd>
            )}
          </div>

          <section className="space-y-1.5" aria-labelledby="project-filters-heading">
            <h3
              id="project-filters-heading"
              className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {t('projects:filters.title')}
            </h3>
            <div className="grid gap-1 sm:grid-cols-3 lg:grid-cols-1">
              {([
                ['all', t('projects:filters.all'), projects.length],
                ['notIndexed', t('projects:filters.notIndexed'), statusCounts.notIndexed],
                ['indexed', t('projects:filters.indexed'), statusCounts.indexed],
              ] as const).map(([value, label, count]) => (
                <Button
                  key={value}
                  type="button"
                  variant={filter === value ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-8 min-w-0 justify-between px-2.5"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  <span className="truncate">{label}</span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">{count}</span>
                </Button>
              ))}
            </div>
          </section>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start"
                aria-label={t('projects:view.title')}
              >
                <SlidersHorizontal className="h-4 w-4" />
                <span className="flex-1 text-left">{t('projects:view.title')}</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              <DropdownMenuLabel>{t('projects:view.organization')}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setGrouped((current) => !current)}>
                <Check className={cn('h-4 w-4', !grouped && 'opacity-0')} />
                {t('projects:groupByGroup')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t('projects:view.layout')}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setLayout('compact')}>
                <LayoutList className="h-4 w-4" />
                <span className="flex-1">{t('projects:compactView')}</span>
                {layout === 'compact' && <Check className="h-4 w-4" />}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setLayout('cards')}>
                <LayoutGrid className="h-4 w-4" />
                <span className="flex-1">{t('projects:cardsView')}</span>
                {layout === 'cards' && <Check className="h-4 w-4" />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <section className="min-w-0 space-y-1.5" aria-labelledby="project-groups-heading">
            <div className="flex items-center justify-between gap-2 px-1">
              <h3
                id="project-groups-heading"
                className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {t('projects:groups.title')}
              </h3>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {navigationGroups.size}
              </span>
            </div>
            <nav
              className="flex min-w-0 gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0"
              aria-label={t('projects:groups.title')}
            >
              <Button
                type="button"
                variant={selectedGroup === null ? 'secondary' : 'ghost'}
                size="sm"
                className="h-8 shrink-0 justify-between px-2.5 lg:w-full"
                aria-pressed={selectedGroup === null}
                onClick={() => setSelectedGroup(null)}
              >
                <span className="truncate">{t('projects:allProjects')}</span>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {projects.length}
                </span>
              </Button>
              {[...navigationGroups.entries()].map(([group, groupProjects]) => {
                const isUngrouped = group === UNGROUPED_PROJECTS_KEY;
                const isSelected = selectedGroup === group;
                return (
                  <Button
                    key={group}
                    type="button"
                    variant={isSelected ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-8 shrink-0 justify-between px-2.5 lg:w-full"
                    aria-pressed={isSelected}
                    onClick={() => setSelectedGroup(group)}
                  >
                    <span className={cn('truncate', isUngrouped && 'italic text-muted-foreground')}>
                      {isUngrouped ? t('projects:ungrouped') : group}
                    </span>
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {groupProjects.length}
                    </span>
                  </Button>
                );
              })}
            </nav>
          </section>
        </div>
      </aside>
  );
}
