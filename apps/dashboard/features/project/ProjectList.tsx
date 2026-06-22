import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  FolderGit2,
  Layers,
  LayoutGrid,
  LayoutList,
  Plus,
  Search,
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
import { Input } from '../../components/ui/input.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { useApi } from '../../hooks/useApi.js';
import { cn } from '../../lib/utils.js';
import ProjectCreateDialog from './ProjectCreateDialog.js';
import { ProjectSettingsModal } from './settings/ProjectSettingsModal.js';
import { NewProjectWizard } from './new-project/index.js';
import { ProjectCard, type ProjectCardData } from './list/ProjectCard.js';
import { ProjectRow } from './list/ProjectRow.js';

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
  const [grouped, setGrouped] = useState(true);
  const [layout, setLayout] = useState<LayoutMode>(readStoredLayout);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Persist layout choice; tiny enough that a debounce would be noise.
  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, layout);
    } catch {
      /* private mode / quota — best-effort */
    }
  }, [layout]);

  // All unique group names defined across projects (for the edit dialog picker)
  const existingGroups = useMemo(() => {
    if (!projects) return [];
    const names = new Set<string>();
    for (const p of projects) {
      if (p.group_name) names.add(p.group_name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [projects]);

  const filteredProjects = useMemo(() => {
    if (!projects) return [];
    const q = searchQuery.toLowerCase().trim();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.root_path.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q) ||
        (p.group_name ?? '').toLowerCase().includes(q),
    );
  }, [projects, searchQuery]);

  const groupedProjects = useMemo(() => {
    if (!grouped) return null;
    const named = new Map<string, Project[]>();
    const ungrouped: Project[] = [];

    for (const p of filteredProjects) {
      if (p.group_name) {
        const bucket = named.get(p.group_name) ?? [];
        bucket.push(p);
        named.set(p.group_name, bucket);
      } else {
        ungrouped.push(p);
      }
    }

    // Sort named groups alphabetically
    const sorted = new Map(
      [...named.entries()].sort(([a], [b]) => a.localeCompare(b)),
    );

    // Ungrouped always at the end
    if (ungrouped.length > 0) {
      sorted.set('__ungrouped__', ungrouped);
    }

    return sorted;
  }, [filteredProjects, grouped]);

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
          <ProjectCreateDialog
            open={creating}
            onOpenChange={setCreating}
            onCreated={(p) => {
              refetch();
              onSelectProject(p.id, p.name);
            }}
          />
        )}
        <NewProjectWizard
          open={scaffolding}
          onOpenChange={setScaffolding}
          onCreated={(p) => {
            refetch();
            onSelectProject(p.id, p.name);
          }}
        />
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
          {t('projects:noMatch', { query: searchQuery })}
        </p>
      );
    }
    if (layout === 'compact') {
      return (
        <div className="flex flex-col gap-1.5">
          {list.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              onSelect={() => onSelectProject(p.id, p.name)}
              onEdit={() => setEditing(p)}
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
          />
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{t('projects:title')}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {searchQuery.trim()
              ? t('projects:searchFiltered', { filtered: filteredProjects.length, total: projects.length })
              : t('projects:count', { count: projects.length })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('projects:searchPlaceholder')}
              className="pl-8 h-8 w-48 sm:w-64 text-sm"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={t('projects:clearSearch')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Button
            variant={grouped ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setGrouped((g) => !g)}
            title={grouped ? t('projects:flatView') : t('projects:groupByGroup')}
          >
            <Layers className="h-4 w-4" />
            <span className="hidden sm:inline ml-1">{grouped ? t('projects:grouped') : t('projects:group')}</span>
          </Button>
          {/* Layout toggle — Cards vs Compact list. Persisted so the
              user's choice survives reloads. Wide-screen muscle memory
              ("LayoutGrid for tiles, LayoutList for rows") inherited
              from VS Code / Finder. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLayout((m) => (m === 'cards' ? 'compact' : 'cards'))}
            title={layout === 'cards' ? t('projects:compactView', { defaultValue: 'Compact list' }) : t('projects:cardsView', { defaultValue: 'Card grid' })}
            aria-label={layout === 'cards' ? 'Switch to compact list' : 'Switch to card grid'}
          >
            {layout === 'cards' ? (
              <LayoutList className="h-4 w-4" />
            ) : (
              <LayoutGrid className="h-4 w-4" />
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCreating(true)} title={t('projects:registerExisting', { defaultValue: 'Register folder' })}>
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline ml-1">{t('projects:registerExisting', { defaultValue: 'Register folder' })}</span>
          </Button>
          <Button size="sm" onClick={() => setScaffolding(true)}>
            <Sparkles className="h-4 w-4" />
            <span className="hidden sm:inline ml-1">{t('projects:newProject')}</span>
          </Button>
        </div>
      </div>

      {!grouped && renderProjects(filteredProjects)}

      {grouped && groupedProjects && (
        <div className="space-y-6">
          {groupedProjects.size === 0 && (
            <p className="text-center py-12 text-sm text-muted-foreground">
              {t('projects:noMatch', { query: searchQuery })}
            </p>
          )}
          {[...groupedProjects.entries()].map(([group, groupProjects]) => {
            const isUngrouped = group === '__ungrouped__';
            const isOpen = searchQuery.length > 0 || !collapsedGroups.has(group);
            return (
              <Collapsible key={group} open={isOpen} onOpenChange={() => toggleGroup(group)}>
                <div className="flex items-center gap-3 mb-3">
                  <CollapsibleTrigger asChild>
                    <button className="flex items-center gap-2 text-sm font-semibold hover:text-primary transition-colors">
                      <ChevronRight
                        className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-90')}
                      />
                      <span className={cn(isUngrouped && 'text-muted-foreground italic')}>
                        {isUngrouped ? t('projects:ungrouped') : group}
                      </span>
                    </button>
                  </CollapsibleTrigger>
                  <Badge variant="muted">{groupProjects.length}</Badge>
                  <div className="flex-1 h-px bg-border" />
                </div>
                <CollapsibleContent>{renderProjects(groupProjects)}</CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      )}

      {editing && (
        <ProjectSettingsModal
          project={editing as unknown as Parameters<typeof ProjectSettingsModal>[0]['project']}
          open={!!editing}
          onOpenChange={(open) => { if (!open) setEditing(null); }}
          initialSection="general"
          onSaved={refetch}
          onDeleted={refetch}
          existingGroups={existingGroups}
        />
      )}
      {creating && (
        <ProjectCreateDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={(p) => {
            refetch();
            onSelectProject(p.id, p.name);
          }}
        />
      )}
      <NewProjectWizard
        open={scaffolding}
        onOpenChange={setScaffolding}
        onCreated={(p) => {
          refetch();
          onSelectProject(p.id, p.name);
        }}
      />
    </div>
  );
}
