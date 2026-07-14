/**
 * Runners scoped to the agents/company session.
 *
 * Reuses the project-level `RunnersTab` (detect + run npm/yarn/composer/
 * gradle/dotnet scripts, with live xterm output) and bolts a
 * `ProjectSelect` on top so the user picks which of the session's linked
 * projects to operate on — the same pattern as the Files/Git/Indexed tabs.
 *
 * Runs are the SAME registry as the per-project view (they live in the
 * main process), so anything started here also shows in the global
 * running-tasks dropdown in the topbar.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import { RunnersTab as ProjectRunnersTab } from '../../../project/tabs/RunnersTab.js';
import { ProjectSelect } from '../../../builder/preview/ProjectSelect.js';
import type { SessionProject } from '../../../builder/preview/useSessionProjects.js';

interface Props {
  projects: SessionProject[];
}

export function RunnersTab({ projects }: Props) {
  const { t } = useTranslation('agents');
  const [projectId, setProjectId] = useState<number | null>(null);
  const effectiveProjectId = projectId ?? projects[0]?.project_id ?? null;

  if (projects.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground flex flex-col items-center gap-2">
        <Play className="h-5 w-5 opacity-50" />
        <span>{t('files.noProject', 'No project linked to the session.')}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="h-10 flex items-center gap-2 px-3 border-b shrink-0">
        <Play className="h-3.5 w-3.5 text-muted-foreground" />
        <ProjectSelect
          projects={projects}
          value={effectiveProjectId}
          onChange={(pid) => setProjectId(pid)}
        />
      </div>
      <div className="flex-1 min-h-0">
        {effectiveProjectId != null && (
          // Key by projectId — remount on switch so the detected list,
          // active runs and output rebind to the new project cleanly.
          <ProjectRunnersTab key={effectiveProjectId} projectId={effectiveProjectId} />
        )}
      </div>
    </div>
  );
}
