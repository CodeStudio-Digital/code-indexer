import React, { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import type { SessionProject } from '../useSessionProjects.js';
import { ProjectSelect } from '../ProjectSelect.js';
import { useGitStatus } from './useGitStatus.js';
import { GitInitCard } from './GitInitCard.js';
import { GitStatusSection } from './GitStatusSection.js';
import { GitLogSection } from './GitLogSection.js';
import { CommitBox } from './CommitBox.js';

interface Props {
  sessionId: number;
  projects: SessionProject[];
}

export function GitTab({ sessionId, projects }: Props) {
  const [projectId, setProjectId] = useState<number | null>(projects[0]?.project_id ?? null);
  const { status, loading, error, refresh, setStatus } = useGitStatus(sessionId, projectId);
  const [logVersion, setLogVersion] = useState(0);

  const refreshAll = async () => {
    await refresh();
    setLogVersion((v) => v + 1);
  };

  if (projects.length === 0) {
    return <div className="p-4 text-xs text-muted-foreground">Nenhum projeto atrelado à sessão.</div>;
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="h-10 flex items-center gap-2 px-3 border-b">
        <ProjectSelect projects={projects} value={projectId} onChange={setProjectId} />
        <div className="flex-1" />
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="p-1.5 rounded-md hover:bg-muted disabled:opacity-40"
          title="Recarregar status do Git"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {error && <div className="p-3 text-xs text-destructive">{error}</div>}
        {!status && loading && (
          <div className="p-4 text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando status…
          </div>
        )}
        {status && !status.isRepo && projectId != null && (
          <GitInitCard
            sessionId={sessionId}
            projectId={projectId}
            onInitialized={(s) => setStatus(s)}
          />
        )}
        {status && status.isRepo && projectId != null && (
          <>
            <GitStatusSection
              sessionId={sessionId}
              projectId={projectId}
              status={status}
              onRefresh={refresh}
            />
            <CommitBox
              sessionId={sessionId}
              projectId={projectId}
              status={status}
              onMutated={refreshAll}
            />
            <GitLogSection sessionId={sessionId} projectId={projectId} version={logVersion} />
          </>
        )}
      </div>
    </div>
  );
}
