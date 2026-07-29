import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import type { SessionProject } from '../useSessionProjects.js';
import { ProjectSelect } from '../ProjectSelect.js';
import { FileTree } from './FileTree.js';
import { FileViewer } from './FileViewer.js';
import { useFileTree, type TreeNode } from './useFileTree.js';
import { useResizableWidth } from '../../../../hooks/useResizableWidth.js';
import { cn } from '../../../../lib/utils.js';

interface Props {
  sessionId: string;
  projects: SessionProject[];
}

function FilesTabBody({
  sessionId,
  projectId,
}: {
  sessionId: string;
  projectId: number | null;
}) {
  const { t } = useTranslation('agents');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const { root, expanded, toggle, error } = useFileTree(sessionId, projectId);
  const handleSelect = (n: TreeNode) => setSelectedPath(n.path);
  // Resizable tree pane — anchored to the left edge of the panel, so
  // dragging RIGHT grows it. Width persists across sessions.
  const treeSizer = useResizableWidth({
    defaultWidth: 280,
    minWidth: 180,
    maxWidth: 560,
    storageKey: 'agents.files.treeWidth',
    anchor: 'left',
  });
  return (
    <div className="flex-1 flex min-h-0">
      <div
        style={{ width: treeSizer.width }}
        className="border-r flex flex-col min-h-0 flex-shrink-0"
      >
        <FileTree
          root={root}
          expanded={expanded}
          selectedPath={selectedPath}
          onToggle={toggle}
          onSelect={handleSelect}
          error={error}
        />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={treeSizer.startResize}
        className={cn(
          'w-1 cursor-col-resize shrink-0 transition-colors',
          treeSizer.resizing ? 'bg-primary/60' : 'bg-border hover:bg-primary/40',
        )}
        title={t('common.resizeHandle', 'Drag to resize')}
      />
      {/* `min-w-0` is critical here: without it, a long line inside the
          viewer would push this flex item beyond its allotted width and
          the horizontal scroll would never engage. With it, the viewer
          stays clipped to its column and `overflow-auto` on the inner
          <pre> shows the scrollbar at the bottom. */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {projectId != null && (
          <FileViewer sessionId={sessionId} projectId={projectId} path={selectedPath} />
        )}
      </div>
    </div>
  );
}

export function FilesTab({ sessionId, projects }: Props) {
  const { t } = useTranslation('agents');
  const [projectId, setProjectId] = useState<number | null>(projects[0]?.project_id ?? null);
  const [refreshKey, setRefreshKey] = useState(0);

  if (projects.length === 0) {
    return <div className="p-4 text-xs text-muted-foreground">{t('files.noProject', 'No project linked to the session.')}</div>;
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
          title={t('files.reloadTree', 'Reload tree')}
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
