/**
 * Activity rail vertical do ProjectView — ícones core/analytics/plugins + toggle de
 * terminal. Extraído do ProjectView (W4 decompose). A config das abas vem do tabs-config.
 *
 * Os botões, a borda e os separadores usam as primitivas compartilhadas de
 * `components/chrome` (as mesmas dos rails do modo Company), garantindo paridade visual.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings2, TerminalSquare } from 'lucide-react';
import type { Project } from '@mcp/shared/types.js';
import { apiCall } from '../../lib/api-client.js';
import { RailButton, RailContainer, RailSeparator } from '../../components/chrome/index.js';
import { useWorkspaceLayout } from '../../state/workspace-layout.js';
import { LinkDesignSystemDialog } from './builder/LinkDesignSystemDialog.js';
import { ProjectSettingsModal } from './settings/ProjectSettingsModal.js';
import { TABS, type ProjectTabId, type TabDef } from './tabs-config.js';

interface ProjectRailProps {
  projectId: number;
  activeTab: ProjectTabId;
  onSelect: (id: ProjectTabId) => void;
  layout: ReturnType<typeof useWorkspaceLayout>;
  pluginTabs: TabDef[];
  /** Conditional core tabs (e.g. Preview, shown when a dev server runs). */
  extraCoreTabs?: TabDef[];
}

export function ProjectRail({ projectId, activeTab, onSelect, layout, pluginTabs, extraCoreTabs = [] }: ProjectRailProps) {
  const { t } = useTranslation(['projects']);
  const core = TABS.filter((t) => t.group === 'core');
  const analytics = TABS.filter((t) => t.group === 'analytics');
  const [project, setProject] = useState<Project | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void apiCall<Project>('projects.get', { id: projectId })
      .then((p) => { if (alive) setProject(p); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [projectId]);

  return (
    <>
    <RailContainer side="left" aria-label="Project sections">
      {core.map((tabDef) => (
        <RailButton
          key={tabDef.id}
          icon={tabDef.icon}
          label={tabDef.label}
          active={activeTab === tabDef.id}
          onClick={() => onSelect(tabDef.id)}
        />
      ))}
      {extraCoreTabs.map((tabDef) => (
        <RailButton
          key={tabDef.id}
          icon={tabDef.icon}
          label={tabDef.label}
          active={activeTab === tabDef.id}
          onClick={() => onSelect(tabDef.id)}
        />
      ))}
      <RailSeparator />
      {analytics.map((tabDef) => (
        <RailButton
          key={tabDef.id}
          icon={tabDef.icon}
          label={tabDef.label}
          active={activeTab === tabDef.id}
          onClick={() => onSelect(tabDef.id)}
        />
      ))}
      {pluginTabs.length > 0 && <RailSeparator />}
      {pluginTabs.map((tabDef) => (
        <RailButton
          key={tabDef.id}
          icon={tabDef.icon}
          label={tabDef.label}
          active={activeTab === tabDef.id}
          onClick={() => onSelect(tabDef.id)}
        />
      ))}
      <div className="mt-auto pb-1 flex flex-col items-center gap-0.5">
        {/* Project-scoped action: link a Design System (auto-hides on
            non-builder projects). Lives in the rail footer since the old
            ProjectTopBar that hosted it was removed. */}
        <LinkDesignSystemDialog projectId={projectId} />
        {/* Project settings — opens the full settings modal (runtimes,
            terminal, general, etc.). Above the terminal toggle. */}
        <RailButton
          icon={Settings2}
          label={t('settings.open')}
          active={false}
          disabled={!project}
          onClick={() => setSettingsOpen(true)}
        />
        {/* Terminal toggle — sits at the bottom of the rail mirroring
            VS Code / JetBrains conventions. Active state reflects
            whether the bottom panel is currently open. */}
        <RailButton
          icon={TerminalSquare}
          label="Terminal (Ctrl+J)"
          role="toggle"
          active={layout.activeBottom !== null}
          onClick={() => layout.setActiveBottom(layout.activeBottom ? null : 'terminal')}
        />
      </div>
    </RailContainer>
    {project && (
      <ProjectSettingsModal
        project={project}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialSection="general"
        onSaved={() => void apiCall<Project>('projects.get', { id: projectId }).then(setProject).catch(() => undefined)}
      />
    )}
    </>
  );
}
