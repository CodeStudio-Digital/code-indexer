import { useState } from 'react';
import { Boxes, Clock, FileCode2, FolderGit2, Pencil, Plus } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { useApi } from '../../hooks/useApi.js';
import { formatRelativeTime } from '../../lib/utils.js';
import ProjectCreateDialog from './ProjectCreateDialog.js';
import ProjectEditDialog from './ProjectEditDialog.js';

interface Project {
  id: number;
  name: string;
  root_path: string;
  description?: string | null;
  file_count: number;
  symbol_count: number;
  last_indexed: string | null;
}

interface ProjectListProps {
  onSelectProject: (id: number, name: string) => void;
}

export default function ProjectList({ onSelectProject }: ProjectListProps) {
  const { data: projects, loading, error, refetch } = useApi<Project[]>('/projects');
  const [editing, setEditing] = useState<Project | null>(null);
  const [creating, setCreating] = useState(false);

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
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Projects</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {projects.length} indexed {projects.length === 1 ? 'project' : 'projects'}
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> Novo projeto
        </Button>
      </div>

      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {projects.map((p) => (
          <Card
            key={p.id}
            onClick={() => onSelectProject(p.id, p.name)}
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
                      setEditing(p);
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
        ))}
      </div>
      {editing && (
        <ProjectEditDialog
          project={editing}
          open={!!editing}
          onOpenChange={(open) => { if (!open) setEditing(null); }}
          onSaved={refetch}
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
