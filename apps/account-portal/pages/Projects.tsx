/** Cloud project library (P6 foundation) — git-pointer entries synced from the
 *  desktop app. Pulled via the sync feed (kind:'project'); requires a Pro plan
 *  (entitlement) and a verified email. */
import { useEffect, useState } from 'react';
import { FolderGit2 } from 'lucide-react';
import { api, ApiError, type ProjectPointer } from '../lib/api.js';
import { Alert, Badge, Card, CardContent, Spinner } from '../lib/ui.js';

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectPointer[] | null>(null);
  const [error, setError] = useState<{ tone: 'destructive' | 'warning' | 'info'; message: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { documents } = await api.pullProjects(0);
        setProjects(
          documents
            .filter((d) => d.kind === 'project' && !d.deleted)
            .map((d) => d.body as ProjectPointer),
        );
      } catch (e) {
        if (e instanceof ApiError && e.kind === 'entitlement') {
          setError({ tone: 'info', message: 'Cloud projects require a Pro plan.' });
        } else if (e instanceof ApiError && e.kind === 'email_unverified') {
          setError({ tone: 'warning', message: 'Verify your email to use the project library.' });
        } else {
          setError({ tone: 'destructive', message: e instanceof ApiError ? e.message : 'Could not load projects.' });
        }
      }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Projects</h1>
        <p className="text-sm text-muted-foreground">Projects you can clone from the cloud.</p>
      </div>

      {error ? <Alert tone={error.tone}>{error.message}</Alert> : null}

      {error ? null : !projects ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </div>
      ) : projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No cloud projects yet. Publish one from the desktop app to see it here.
        </p>
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {projects.map((p, i) => (
              <div key={p.gitRemote || `${p.name}-${i}`} className="flex items-start gap-3 p-4">
                <FolderGit2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  {p.description ? (
                    <div className="truncate text-xs text-muted-foreground">{p.description}</div>
                  ) : null}
                  {p.gitRemote ? (
                    <div className="mt-1 flex items-center gap-2">
                      <span className="truncate font-mono text-xs text-muted-foreground">{p.gitRemote}</span>
                      {p.defaultBranch ? <Badge tone="muted">{p.defaultBranch}</Badge> : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
