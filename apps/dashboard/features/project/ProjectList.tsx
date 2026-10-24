import type { Project as SettingsProject } from '@mcp/shared/types.js';
import {
  ChevronRight,
  FolderGit2,
  ListChecks,
  Sparkles,
  Trash2,
  X
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/ui/collapsible.js';
import { toast } from '../../components/ui/prompt-dialog.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { useApi } from '../../hooks/useApi.js';
import { cn } from '../../lib/utils.js';
import { loadRecentProjects } from '../../state/recent-projects.js';
import {
  BulkDeleteProjectsDialog,
  type BulkProjectDeleteResponse,
} from './list/BulkDeleteProjectsDialog.js';
import { type ProjectCardData } from './list/ProjectCard.js';
import { ProjectListItems } from './list/ProjectListItems.js';
import {
  countProjectStatuses,
  filterProjectList,
  filterProjectsByGroup,
  groupProjectList,
  recentProjectList,
  UNGROUPED_PROJECTS_KEY,
  type ProjectListFilter,
} from './list/projectListModel.js';
import { ProjectListNavigation } from './list/ProjectListNavigation.js';
import { useProjectIndexAction } from './list/useProjectIndexAction.js';
import { useProjectListPresentation } from './list/useProjectListPresentation.js';

const ProjectCreateDialog = lazy(() => import('./ProjectCreateDialog.js'));
const ProjectSettingsModal = lazy(() =>
  import('./settings/ProjectSettingsModal.js').then((module) => ({ default: module.ProjectSettingsModal })),
);
const NewProjectWizard = lazy(() => import('./new-project/NewProjectWizard.js'));

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
  const { layout, setLayout, searchInputRef } = useProjectListPresentation();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const { indexingIds, handleIndexProject } = useProjectIndexAction(refetch);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [recentIds] = useState(loadRecentProjects);

  // Stable row handlers so `React.memo(ProjectRow)` actually dedupes — the
  // compact list can be 40+ rows and per-row inline arrows would re-render
  // every row on any parent update.
  const handleSelectProject = useCallback(
    (p: Project) => onSelectProject(p.id, p.name),
    [onSelectProject],
  );
  const handleEditProject = useCallback((p: Project) => setEditing(p), []);
  const handleToggleSelected = useCallback((p: Project) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      next.has(p.id) ? next.delete(p.id) : next.add(p.id);
      return next;
    });
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
  const selectedProjects = useMemo(
    () => (projects ?? []).filter((project) => selectedIds.has(project.id)),
    [projects, selectedIds],
  );
  const allVisibleSelected = visibleProjects.length > 0
    && visibleProjects.every((project) => selectedIds.has(project.id));

  useEffect(() => {
    if (selectedGroup === null || !projects) return;
    const selectionStillExists =
      selectedGroup === UNGROUPED_PROJECTS_KEY
        ? projects.some((project) => !project.group_name)
        : projects.some((project) => project.group_name === selectedGroup);
    if (!selectionStillExists) setSelectedGroup(null);
  }, [projects, selectedGroup]);

  useEffect(() => {
    if (!projects || selectedIds.size === 0) return;
    const availableIds = new Set(projects.map((project) => project.id));
    if ([...selectedIds].every((id) => availableIds.has(id))) return;
    setSelectedIds((current) => new Set([...current].filter((id) => availableIds.has(id))));
  }, [projects, selectedIds]);

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }

  function toggleVisibleSelection() {
    setSelectedIds((current) => {
      if (allVisibleSelected) return new Set();
      const next = new Set(current);
      for (const project of visibleProjects) next.add(project.id);
      return next;
    });
  }

  function handleBulkDeleteCompleted(result: BulkProjectDeleteResponse) {
    const catalogFailures = result.results.filter((item) => !item.catalog_deleted);
    const errors = result.results.filter((item) => item.error);
    setSelectedIds(new Set(catalogFailures.map((item) => item.id)));
    if (catalogFailures.length === 0) setSelectionMode(false);
    refetch();

    if (errors.length > 0) {
      const firstError = errors[0];
      toast.warning(t('projects:bulkDelete.partial'), {
        description: t('projects:bulkDelete.partialDescription', {
          projects: result.projects_deleted,
          errors: errors.length,
          detail: [firstError.root_path, firstError.error].filter(Boolean).join(': '),
        }),
      });
      return;
    }
    toast.success(t('projects:bulkDelete.completed'), {
      description: t('projects:bulkDelete.completedDescription', {
        projects: result.projects_deleted,
        folders: result.folders_deleted,
      }),
    });
  }

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

  const renderProjects = (list: Project[]) => (
    <ProjectListItems list={list}
      layout={layout}
      searchQuery={searchQuery}
      handleSelectProject={handleSelectProject}
      handleEditProject={handleEditProject}
      handleIndexProject={handleIndexProject}
      handleToggleSelected={handleToggleSelected}
      indexingIds={indexingIds}
      selectionMode={selectionMode}
      selectedIds={selectedIds}
    />
  );

  const selectedGroupLabel =
    selectedGroup === null
      ? t('projects:allProjects')
      : selectedGroup === UNGROUPED_PROJECTS_KEY
        ? t('projects:ungrouped')
        : selectedGroup;

  return (
    <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[17rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)]">
      <ProjectListNavigation
        projects={projects}
        statusCounts={statusCounts}
        setScaffolding={setScaffolding}
        setCreating={setCreating}
        searchInputRef={searchInputRef}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        filter={filter}
        setFilter={setFilter}
        grouped={grouped}
        setGrouped={setGrouped}
        layout={layout}
        setLayout={setLayout}
        navigationGroups={navigationGroups}
        selectedGroup={selectedGroup}
        setSelectedGroup={setSelectedGroup}
      />

      <section className="min-w-0 space-y-5">
        {recentProjects.length > 0 &&
          !selectionMode &&
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

        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b pb-3">
          <div className="flex min-w-0 items-center gap-3">
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

          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {selectionMode ? (
              <>
                <Badge variant="muted" className="normal-case tracking-normal">
                  {t('projects:selection.selected', { count: selectedProjects.length })}
                </Badge>
                <Button variant="outline" size="sm" onClick={toggleVisibleSelection}>
                  <ListChecks className="h-4 w-4" />
                  {allVisibleSelected
                    ? t('projects:selection.clear')
                    : t('projects:selection.selectVisible')}
                </Button>
                {selectedProjects.length > 0 && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setBulkDeleteOpen(true)}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t('projects:bulkDelete.confirm', { count: selectedProjects.length })}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={exitSelectionMode}
                  aria-label={t('projects:selection.exit')}
                >
                  <X className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setSelectionMode(true)}>
                <ListChecks className="h-4 w-4" />
                {t('projects:selection.select')}
              </Button>
            )}
          </div>
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

      <BulkDeleteProjectsDialog
        open={bulkDeleteOpen}
        projects={selectedProjects}
        onOpenChange={setBulkDeleteOpen}
        onCompleted={handleBulkDeleteCompleted}
      />

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
