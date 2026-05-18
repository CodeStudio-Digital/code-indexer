/**
 * Git tab for the agents view's Build zone.
 *
 * The heavy lifting (status / diff / commit / log / init) lives in
 * `apps/dashboard/features/builder/preview/git/GitTab.tsx`, which we
 * mount here directly. The agents wrapper only resolves the session's
 * projects list — sub-sessions (fronts) share the parent's sandbox and
 * project links, so we always pass the ROOT session id, never the
 * active front id.
 *
 * Backend endpoints (`/api/company/sessions/:sid/projects/:pid/git/*`)
 * are owned by `apps/http-api/server/routes/workspace/git.routes.ts`
 * and already in place; Phase 7 only adds the integration here.
 */
import { useSessionProjects } from '../../../builder/preview/useSessionProjects.js';
import { GitTab as BuilderGitTab } from '../../../builder/preview/git/GitTab.js';

interface AgentsGitTabProps {
  /** Root session id — the one that owns the sandbox/project links. */
  sessionId: number;
}

export function GitTab({ sessionId }: AgentsGitTabProps) {
  const { projects, loading, error } = useSessionProjects(sessionId);

  if (loading && projects.length === 0) {
    return <div className="p-4 text-xs text-muted-foreground">Loading projects…</div>;
  }
  if (error) {
    return <div className="p-4 text-xs text-destructive">{error}</div>;
  }
  return <BuilderGitTab sessionId={sessionId} projects={projects} />;
}
