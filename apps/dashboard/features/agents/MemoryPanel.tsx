/**
 * Project-memory tab for the company view (Mem C).
 *
 * The memory itself is the project's context-snapshot store (migrations
 * 114/115) — the same snapshots the run-end distiller writes and the
 * spawn-time PROJECT MEMORY block reads. This tab is the operator's
 * curation valve: inspect what agents will be born knowing, fix wrong
 * memories, delete noise, add hand-written decisions.
 *
 * Zero new endpoints: mounts the existing `SnapshotEditor`
 * (features/snapshots) over `/api/projects/:id/snapshots`, with a
 * `ProjectSelect` on top to flip between the session's linked projects —
 * same composition as `IndexedFilesTab`.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain } from 'lucide-react';
import SnapshotEditor from '../snapshots/SnapshotEditor.js';
import { ProjectSelect } from '../builder/preview/ProjectSelect.js';
import { useSessionProjects } from '../builder/preview/useSessionProjects.js';

interface MemoryPanelProps {
  sessionId: string;
}

export function MemoryPanel({ sessionId }: MemoryPanelProps) {
  const { t } = useTranslation('agents');
  const { projects, loading, error } = useSessionProjects(sessionId);
  const [projectId, setProjectId] = useState<number | null>(null);

  // Default to the first linked project once the list resolves — same
  // convention as IndexedFilesTab / BuilderFilesTab.
  const effectiveProjectId = projectId ?? projects[0]?.project_id ?? null;

  if (loading && projects.length === 0) {
    return <div className="p-4 text-xs text-muted-foreground">{t('memory.loading', 'Loading projects…')}</div>;
  }
  if (error) {
    return <div className="p-4 text-xs text-destructive">{error}</div>;
  }
  if (projects.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground flex flex-col items-center gap-2">
        <Brain className="h-5 w-5 opacity-50" />
        <span>{t('files.noProject', 'No project linked to the session.')}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="h-10 flex items-center gap-2 px-3 border-b shrink-0">
        <Brain className="h-3.5 w-3.5 text-muted-foreground" />
        <ProjectSelect
          projects={projects}
          value={effectiveProjectId}
          onChange={(pid) => setProjectId(pid)}
        />
        <span className="text-[10.5px] text-muted-foreground/70 ml-auto">
          {t('memory.hint', 'What new agents are born knowing — curate, fix or delete.')}
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {effectiveProjectId != null && (
          // Key by projectId — full remount on project switch so the
          // selection/filter state resets with the new snapshot list.
          <SnapshotEditor key={effectiveProjectId} projectId={effectiveProjectId} />
        )}
      </div>
    </div>
  );
}
