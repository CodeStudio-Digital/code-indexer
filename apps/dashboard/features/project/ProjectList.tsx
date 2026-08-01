import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  FolderGit2,
  LayoutGrid,
  LayoutList,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/ui/collapsible.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { Input } from '../../components/ui/input.js';
import { toast } from '../../components/ui/prompt-dialog.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { apiPost, useApi } from '../../hooks/useApi.js';
import { cn } from '../../lib/utils.js';
import { loadRecentProjects } from '../../state/recent-projects.js';
import type { Project as SettingsProject } from '@mcp/shared/types.js';
import { ProjectCard, type ProjectCardData } from './list/ProjectCard.js';
import {
  countProjectStatuses,
  filterProjectList,
  filterProjectsByGroup,
  groupProjectList,
  recentProjectList,
  type ProjectListFilter,
  UNGROUPED_PROJECTS_KEY,
} from './list/projectListModel.js';
import { ProjectRow } from './list/ProjectRow.js';

const ProjectCreateDialog = lazy(() => import('./ProjectCreateDialog.js'));
const ProjectSettingsModal = lazy(() =>
  import('./settings/ProjectSettingsModal.js').then((module) => ({ default: module.ProjectSettingsModal })),
);
const NewProjectWizard = lazy(() => import('./new-project/NewProjectWizard.js'));

/** Persisted in localStorage so the user's layout choice survives reloads. */
type LayoutMode = 'cards' | 'compact';
const LAYOUT_STORAGE_KEY = 'projectsList.layout';

function readStoredLayout(): LayoutMode {
  // Compact é o default — em projetos com 15+ entries, cards forçam
  // muita rolagem; compact deixa todos os projetos visíveis numa única
  // tela. User pode alternar pro grid via toggle no header.
  if (typeof window === 'undefined') return 'compact';
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    return raw === 'cards' ? 'cards' : 'compact';
  } catch {
    return 'compact';
  }
}

type Project = ProjectCardData;

interface ProjectListProps {
  onSelectProject: (id: number, name: string) => void;
}

export default function ProjectList({ onSelectProject }: ProjectListProps) {
  const { t } = useTranslation(['projects', 'common']);
  const { data: projects, loading, error, refetch } = useApi<Project[]>('/projects');
  const [editing, setEditing] = useState<Project | null>(null);
  const [creating, setCreating] = useState(false);
  const [scaffolding, setScaffolding] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<ProjectListFilter>('all');
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [grouped, setGrouped] = useState(true);
  const [layout, setLayout] = useState<LayoutMode>(readStoredLayout);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [indexingIds, setIndexingIds] = useState<Set<number>>(new Set());
  const [recentIds] = useState(loadRecentProjects);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const indexingIdsRef = useRef<Set<number>>(new Set());

  // Stable row handlers so `React.memo(ProjectRow)` actually dedupes — the
  // compact list can be 40+ rows and per-row inline arrows would re-render
  // every row on any parent update.
  const handleSelectProject = useCallback(
    (p: Project) => onSelectProject(p.id, p.name),
    [onSelectProject],
  );
  const handleEditProject = useCallback((p: Project) => setEditing(p), []);
  const handleIndexProject = useCallback(
    async (p: Project) => {
      if (indexingIdsRef.current.has(p.id)) return;
      indexingIdsRef.current.add(p.id);
      setIndexingIds((current) => new Set(current).add(p.id));
      try {
        const result = await apiPost<{ ok: boolean }>(
          `/projects/${encodeURIComponent(p.id)}/index/structural/reconcile`,
          {},
        );
        refetch();
        if (result.ok) {
          toast.success(t('projects:indexAction.completed'), {
            description: p.name,
          });
        } else {
          toast.info(t('projects:indexAction.continuing'), {
            description: p.name,
          });
        }
      } catch (indexError) {
        toast.error(t('projects:indexAction.failed'), {
          description:
            indexError instanceof Error ? indexError.message : String(indexError),
        });
      } finally {
        indexingIdsRef.current.delete(p.id);
        setIndexingIds((current) => {
          const next = new Set(current);
          next.delete(p.id);
          return next;
        });
      }
    },
    [refetch, t],
  );

  // Persist layout choice; tiny enough that a debounce would be noise.
  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, layout);
    } catch {
      /* private mode / quota — best-effort */
    }
  }, [layout]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (
        event.key !== '/' ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT'
      ) {
        return;
      }
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  // All unique group names defined across projects (for the edit dialog picker)
  const existingGroups = useMemo(() => {
    if (!projects) return [];
    const names = new Set<string>();
    for (const p of projects) {
      if (p.group_name) names.add(p.group_name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [projects]);

  const filteredProjects = useMemo(
    () => filterProjectList(projects ?? [], searchQuery, filter),
    [projects, searchQuery, filter],
  );
  const visibleProjects = useMemo(
    () => filterProjectsByGroup(filteredProjects, selectedGroup),
    [filteredProjects, selectedGroup],
  );
  const groupedProjects = useMemo(
    () => (grouped && selectedGroup === null ? groupProjectList(visibleProjects) : null),
    [grouped, selectedGroup, visibleProjects],
  );
  const navigationGroups = useMemo(
    () => groupProjectList(projects ?? []),
    [projects],
  );
  const recentProjects = useMemo(
    () => recentProjectList(projects ?? [], recentIds),
    [projects, recentIds],
  );
  const statusCounts = useMemo(
    () => countProjectStatuses(projects ?? []),
    [projects],
  );

  useEffect(() => {
    if (selectedGroup === null || !projects) return;
    const selectionStillExists =
      selectedGroup === UNGROUPED_PROJECTS_KEY
        ? projects.some((project) => !project.group_name)
        : projects.some((project) => project.group_name === selectedGroup);
    if (!selectionStillExists) setSelectedGroup(null);
  }, [projects, selectedGroup]);

  function toggleGroup(group: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      next.has(group) ? next.delete(group) : next.add(group);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-44 w-full" />
        ))}
      </div>
    );
  }
  if (error) return <div className="text-destructive text-sm">Error: {error}</div>;

  if (!projects || projects.length === 0) {
    return (
      <>
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center gap-4">
            <div className="h-14 w-14 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
              <FolderGit2 className="h-7 w-7" />
            </div>
            <div>
              <h2 className="text-xl font-semibold">{t('projects:empty.title')}</h2>
              <p className="text-sm text-muted-foreground mt-1">
                {t('projects:empty.description')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={() => setScaffolding(true)}>
                <Sparkles className="h-4 w-4" /> {t('projects:newProject')}
              </Button>
              <Button variant="outline" onClick={() => setCreating(true)}>
                <FolderGit2 className="h-4 w-4" /> {t('projects:registerExisting', { defaultValue: 'Register folder' })}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('projects:empty.cliHint')}{' '}
              <code className="bg-muted px-2 py-1 rounded-md font-mono">
                mcp-code-indexer index /path/to/project
              </code>
            </p>
          </CardContent>
        </Card>
        {creating && (
          <Suspense fallback={null}>
            <ProjectCreateDialog
              open={creating}
              onOpenChange={setCreating}
              onCreated={(p) => {
                refetch();
                onSelectProject(p.id, p.name);
              }}
            />
          </Suspense>
        )}
        {scaffolding && (
          <Suspense fallback={null}>
            <NewProjectWizard
              open={scaffolding}
              onOpenChange={setScaffolding}
              onCreated={(p) => {
                refetch();
                onSelectProject(p.id, p.name);
              }}
            />
          </Suspense>
        )}
      </>
    );
  }

  // Shared list renderer — picks card grid or compact row stack based on
  // the persisted `layout`. Both views share the same data + handlers so
  // toggling never loses scroll position relative to the same project.
  const renderProjects = (list: Project[]) => {
    if (list.length === 0) {
      return (
        <p className="col-span-full text-center py-8 text-sm text-muted-foreground">
          {searchQuery.trim()
            ? t('projects:noMatch', { query: searchQuery })
            : t('projects:noProjectsForFilter')}
        </p>
      );
    }
    if (layout === 'compact') {
      return (
        <div className="overflow-hidden rounded-lg border bg-card/40">
          {list.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              onSelect={handleSelectProject}
              onEdit={handleEditProject}
              onIndex={handleIndexProject}
              indexing={indexingIds.has(p.id)}
            />
          ))}
        </div>
      );
    }
    return (
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {list.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            onSelect={() => onSelectProject(p.id, p.name)}
            onEdit={() => setEditing(p)}
            onIndex={() => void handleIndexProject(p)}
            indexing={indexingIds.has(p.id)}
          />
        ))}
      </div>
    );
  };

  const selectedGroupLabel =
    selectedGroup === null
      ? t('projects:allProjects')
      : selectedGroup === UNGROUPED_PROJECTS_KEY
        ? t('projects:ungrouped')
        : selectedGroup;

  return (
    <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[17rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)]">
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

      <section className="min-w-0 space-y-5">
        {recentProjects.length > 0 &&
          selectedGroup === null &&
          !searchQuery.trim() &&
          filter === 'all' && (
            <section className="space-y-2" aria-labelledby="recent-projects-heading">
              <h3
                id="recent-projects-heading"
                className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {t('projects:recent')}
              </h3>
              <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-4">
                {recentProjects.map((project) => (
                  <Button
                    key={project.id}
                    variant="outline"
                    className="h-auto min-w-0 justify-start px-3 py-2.5 text-left"
                    onClick={() => handleSelectProject(project)}
                  >
                    <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{project.name}</span>
                      <span className="block truncate font-mono text-[10px] font-normal text-muted-foreground">
                        {project.root_path}
                      </span>
                    </span>
                  </Button>
                ))}
              </div>
            </section>
          )}

        <div className="flex min-w-0 items-center justify-between gap-3 border-b pb-3">
          <h3 className="truncate text-base font-semibold">{selectedGroupLabel}</h3>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {searchQuery.trim() || filter !== 'all' || selectedGroup !== null
              ? t('projects:searchFiltered', {
                  filtered: visibleProjects.length,
                  total: projects.length,
                })
              : t('projects:visibleCount', { count: visibleProjects.length })}
          </span>
        </div>

        {(!grouped || selectedGroup !== null) && renderProjects(visibleProjects)}

        {grouped && selectedGroup === null && groupedProjects && (
          <div className="space-y-5">
            {groupedProjects.size === 0 && (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {searchQuery.trim()
                  ? t('projects:noMatch', { query: searchQuery })
                  : t('projects:noProjectsForFilter')}
              </p>
            )}
            {[...groupedProjects.entries()].map(([group, groupProjects]) => {
              const isUngrouped = group === UNGROUPED_PROJECTS_KEY;
              const isOpen = searchQuery.trim().length > 0 || !collapsedGroups.has(group);
              const notIndexedCount = groupProjects.filter(
                (project) => !project.last_indexed,
              ).length;
              return (
                <Collapsible key={group} open={isOpen} onOpenChange={() => toggleGroup(group)}>
                  <div className="mb-2">
                    <CollapsibleTrigger asChild>
                      <button className="flex w-full items-center gap-2 border-b pb-2 text-left text-sm font-semibold transition-colors hover:text-primary">
                        <ChevronRight
                          className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-90')}
                        />
                        <span className={cn(isUngrouped && 'italic text-muted-foreground')}>
                          {isUngrouped ? t('projects:ungrouped') : group}
                        </span>
                        <Badge variant="muted" className="normal-case tracking-normal">
                          {groupProjects.length}
                        </Badge>
                        <span className="ml-auto text-xs font-normal text-muted-foreground">
                          {notIndexedCount > 0
                            ? t('projects:groupNotIndexed', { count: notIndexedCount })
                            : t('projects:groupAllIndexed')}
                        </span>
                      </button>
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent>{renderProjects(groupProjects)}</CollapsibleContent>
                </Collapsible>
              );
            })}
          </div>
        )}
      </section>

      {editing && (
        <Suspense fallback={null}>
          <ProjectSettingsModal
            project={editing as unknown as SettingsProject}
            open={!!editing}
            onOpenChange={(open) => { if (!open) setEditing(null); }}
            initialSection="general"
            onSaved={refetch}
            onDeleted={refetch}
            existingGroups={existingGroups}
          />
        </Suspense>
      )}
      {creating && (
        <Suspense fallback={null}>
          <ProjectCreateDialog
            open={creating}
            onOpenChange={setCreating}
            onCreated={(p) => {
              refetch();
              onSelectProject(p.id, p.name);
            }}
          />
        </Suspense>
      )}
      {scaffolding && (
        <Suspense fallback={null}>
          <NewProjectWizard
            open={scaffolding}
            onOpenChange={setScaffolding}
            onCreated={(p) => {
              refetch();
              onSelectProject(p.id, p.name);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
