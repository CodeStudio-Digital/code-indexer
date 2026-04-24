import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { SessionProject } from '../useSessionProjects.js';
import { ProjectSelect } from '../ProjectSelect.js';
import { FileTree } from './FileTree.js';
import { FileViewer } from './FileViewer.js';
import { useFileTree, type TreeNode } from './useFileTree.js';

interface Props {
  sessionId: number;
  projects: SessionProject[];
}

function FilesTabBody({
  sessionId,
  projectId,
}: {
  sessionId: number;
  projectId: number | null;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const { root, expanded, toggle, error } = useFileTree(sessionId, projectId);
  const handleSelect = (n: TreeNode) => setSelectedPath(n.path);
  return (
    <div className="flex-1 flex min-h-0">
      <div className="w-1/3 min-w-[200px] max-w-[360px] border-r flex flex-col min-h-0">
        <FileTree
          root={root}
          expanded={expanded}
          selectedPath={selectedPath}
          onToggle={toggle}
          onSelect={handleSelect}
          error={error}
        />
      </div>
      <div className="flex-1 flex flex-col min-h-0">
        {projectId != null && (
          <FileViewer sessionId={sessionId} projectId={projectId} path={selectedPath} />
        )}
      </div>
    </div>
  );
}

export function FilesTab({ sessionId, projects }: Props) {
  const [projectId, setProjectId] = useState<number | null>(projects[0]?.project_id ?? null);
  const [refreshKey, setRefreshKey] = useState(0);

  if (projects.length === 0) {
    return <div className="p-4 text-xs text-muted-foreground">Nenhum projeto atrelado à sessão.</div>;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="h-10 flex items-center gap-2 px-3 border-b">
        <ProjectSelect
          projects={projects}
          value={projectId}
          onChange={(pid) => setProjectId(pid)}
        />
        <div className="flex-1" />
        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          className="p-1.5 rounded-md hover:bg-muted"
          title="Recarregar árvore"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      <FilesTabBody
        key={`${projectId}-${refreshKey}`}
        sessionId={sessionId}
        projectId={projectId}
      />
    </div>
  );
}
