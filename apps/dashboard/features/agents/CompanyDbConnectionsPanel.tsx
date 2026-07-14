/**
 * Company database navigator host.
 *
 * The Company session owns the project selector while the regular project
 * `DatabaseToolWindow` is portalled below it. This keeps one database client
 * implementation for Project and Company and lets tables/queries open in the
 * Company center without navigating away from the running session.
 */
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, FolderKanban } from 'lucide-react';
import { Combobox } from '../../components/ui/combobox.js';
import { WorkbenchPanelHeader } from '../../components/workbench/WorkbenchChrome.js';
import type { SessionProject } from './session-view/types.js';

interface CompanyDbConnectionsPanelProps {
  projects: SessionProject[];
  selectedProjectId: number | null;
  onSelectProject: (projectId: number) => void;
  onHostChange: (host: HTMLDivElement | null) => void;
}

export default function CompanyDbConnectionsPanel({
  projects,
  selectedProjectId,
  onSelectProject,
  onHostChange,
}: CompanyDbConnectionsPanelProps) {
  const { t } = useTranslation('agents');
  const projectOptions = useMemo(() => projects.map((project) => ({
    value: String(project.project_id),
    label: project.label?.trim() || project.project_name,
    description: project.root_path,
  })), [projects]);

  useEffect(() => {
    if (projects.length === 0) return;
    if (selectedProjectId != null && projects.some((project) => project.project_id === selectedProjectId)) return;
    onSelectProject(projects[0].project_id);
  }, [onSelectProject, projects, selectedProjectId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--workbench-surface)]">
      <WorkbenchPanelHeader title={t('dbConnections.title')} icon={Database} />
      <div className="shrink-0 space-y-2 border-b border-[var(--workbench-border)] p-2">
        <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          <FolderKanban className="h-3 w-3" />
          {t('dbConnections.project')}
        </div>
        <Combobox
          value={selectedProjectId == null ? '' : String(selectedProjectId)}
          onChange={(value) => onSelectProject(Number(value))}
          options={projectOptions}
          placeholder={t('dbConnections.selectProject')}
          searchPlaceholder={t('dbConnections.searchProject')}
          emptyLabel={t('dbConnections.noProjects')}
          className="h-7"
        />
        <p className="text-[10.5px] leading-snug text-muted-foreground">
          {t('dbConnections.embeddedDescription')}
        </p>
      </div>

      {projects.length > 0 ? (
        <div ref={onHostChange} className="min-h-0 flex-1 overflow-hidden" />
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center p-4 text-center">
          <div className="space-y-1.5 text-muted-foreground">
            <Database className="mx-auto h-5 w-5 opacity-60" />
            <p className="text-xs font-medium text-foreground">{t('dbConnections.noProjects')}</p>
            <p className="text-[11px] leading-relaxed">{t('dbConnections.noProjectsHint')}</p>
          </div>
        </div>
      )}
    </div>
  );
}
