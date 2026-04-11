import { useMemo, useState } from 'react';
import {
  Boxes,
  ChevronRight,
  Clock,
  FileCode2,
  FolderGit2,
  Layers,
  Pencil,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/ui/collapsible.js';
import { Input } from '../../components/ui/input.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { useApi } from '../../hooks/useApi.js';
import { cn, formatRelativeTime } from '../../lib/utils.js';
import ProjectCreateDialog from './ProjectCreateDialog.js';
import ProjectEditDialog from './ProjectEditDialog.js';

interface Project {
  id: number;
  name: string;
  root_path: string;
  description?: string | null;
  group_name?: string | null;
  file_count: number;
  symbol_count: number;
  last_indexed: string | null;
}

interface ProjectListProps {
  onSelectProject: (id: number, name: string) => void;
}

interface ProjectCardProps {
  project: Project;
  onSelect: () => void;
  onEdit: () => void;
}

function ProjectCard({ project: p, onSelect, onEdit }: ProjectCardProps) {
  return (
    <Card
      onClick={onSelect}
      className="cursor-pointer transition-all hover:shadow-md hover:border-primary/40 hover:-translate-y-0.5 group"
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
            <FolderGit2 className="h-5 w-5" />
          </div>
          <div className="flex items-center gap-1">
            <Badge variant={p.last_indexed ? 'success' : 'muted'}>
              {p.last_indexed ? 'indexed' : 'pending'}
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              aria-label="Edit project"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <CardTitle className="text-base mt-3 truncate">{p.name}</CardTitle>
        <CardDescription className="text-xs truncate font-mono">{p.root_path}</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <FileCode2 className="h-3.5 w-3.5" />
            <span>
              <strong className="text-foreground">{p.file_count}</strong> files
            </span>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <Boxes className="h-3.5 w-3.5" />
            <span>
              <strong className="text-foreground">{p.symbol_count}</strong> symbols
            </span>
          </div>
        </div>
        <div className="mt-3 pt-3 border-t flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          {p.last_indexed ? formatRelativeTime(p.last_indexed) : 'Never indexed'}
        </div>
      </CardContent>
    </Card>
  );
}

export default function ProjectList({ onSelectProject }: ProjectListProps) {
  const { data: projects, loading, error, refetch } = useApi<Project[]>('/projects');
  const [editing, setEditing] = useState<Project | null>(null);
  const [creating, setCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [grouped, setGrouped] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

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

    // "Sem grupo" always at the end
    if (ungrouped.length > 0) {
      sorted.set('Sem grupo', ungrouped);
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
              <h2 className="text-xl font-semibold">Nenhum projeto ainda</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Crie um projeto registrando uma pasta local.
              </p>
            </div>
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> Novo projeto
            </Button>
            <p className="text-xs text-muted-foreground">
              Ou use o CLI:{' '}
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
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Projects</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {searchQuery.trim()
              ? `${filteredProjects.length} of ${projects.length} projects`
              : `${projects.length} indexed ${projects.length === 1 ? 'project' : 'projects'}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search projects…"
              className="pl-8 h-8 w-48 sm:w-64 text-sm"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Button
            variant={grouped ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setGrouped((g) => !g)}
            title={grouped ? 'Flat view' : 'Group by group'}
          >
            <Layers className="h-4 w-4" />
            <span className="hidden sm:inline ml-1">{grouped ? 'Grouped' : 'Group'}</span>
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline ml-1">Novo projeto</span>
          </Button>
        </div>
      </div>

      {!grouped && (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {filteredProjects.length === 0 ? (
            <p className="col-span-full text-center py-12 text-sm text-muted-foreground">
              No projects match &ldquo;{searchQuery}&rdquo;
            </p>
          ) : (
            filteredProjects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onSelect={() => onSelectProject(p.id, p.name)}
                onEdit={() => setEditing(p)}
              />
            ))
          )}
        </div>
      )}

      {grouped && groupedProjects && (
        <div className="space-y-6">
          {groupedProjects.size === 0 && (
            <p className="text-center py-12 text-sm text-muted-foreground">
              No projects match &ldquo;{searchQuery}&rdquo;
            </p>
          )}
          {[...groupedProjects.entries()].map(([group, groupProjects]) => {
            const isUngrouped = group === 'Sem grupo';
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
                        {group}
                      </span>
                    </button>
                  </CollapsibleTrigger>
                  <Badge variant="muted">{groupProjects.length}</Badge>
                  <div className="flex-1 h-px bg-border" />
                </div>
                <CollapsibleContent>
                  <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                    {groupProjects.map((p) => (
                      <ProjectCard
                        key={p.id}
                        project={p}
                        onSelect={() => onSelectProject(p.id, p.name)}
                        onEdit={() => setEditing(p)}
                      />
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      )}

      {editing && (
        <ProjectEditDialog
          project={editing}
          open={!!editing}
          onOpenChange={(open) => { if (!open) setEditing(null); }}
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
    </div>
  );
}
