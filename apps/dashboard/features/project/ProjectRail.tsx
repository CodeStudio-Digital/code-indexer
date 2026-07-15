/** Left activity rail: project and source-control tool windows only. */
import { Fragment, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pin, Settings2, TerminalSquare } from 'lucide-react';
import type { Project } from '@mcp/shared/types.js';
import { apiCall } from '../../lib/api-client.js';
import { RailButton, RailContainer, RailSeparator } from '../../components/chrome/index.js';
import type { ContextMenuItem } from '../../components/ui/context-menu.js';
import { hasPin, usePinnedTabs } from '../../state/pinned-tabs.js';
import { buildRailPin } from '../../state/pinned-tabs-describe.js';
import { railPinId } from '../../state/pinned-tabs-types.js';
import { LinkDesignSystemDialog } from './builder/LinkDesignSystemDialog.js';
import { ProjectSettingsModal } from './settings/ProjectSettingsModal.js';
import { LEFT_TOOL_TABS, WORKSPACE_SURFACES, type TabDef } from './tabs-config.js';

interface ProjectRailProps {
  projectId: number;
  activeTool: string | null;
  activeSurface: string;
  onToggle: (id: string) => void;
  onSelectSurface: (id: string) => void;
  previewEnabled: boolean;
  bottomOpen: boolean;
  onToggleBottom: () => void;
  pluginTabs: TabDef[];
}

export function ProjectRail({
  projectId,
  activeTool,
  activeSurface,
  onToggle,
  onSelectSurface,
  previewEnabled,
  bottomOpen,
  onToggleBottom,
  pluginTabs,
}: ProjectRailProps) {
  const { t } = useTranslation(['projects']);
  const [project, setProject] = useState<Project | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const railItems = (tab: TabDef): ContextMenuItem[] => [
    {
      id: 'pin-rail',
      label: hasPin(railPinId(projectId, tab.id)) ? t('pins:unpin') : t('pins:pin'),
      icon: Pin,
      onSelect: () =>
        usePinnedTabs.getState().togglePin(
          buildRailPin({ projectId, tabId: tab.id, label: tab.label, projectName: project?.name }),
        ),
    },
  ];

  useEffect(() => {
    let alive = true;
    void apiCall<Project>('projects.get', { id: projectId })
      .then((value) => { if (alive) setProject(value); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [projectId]);

  const renderTool = (tab: TabDef) => (
    <RailButton
      key={tab.id}
      icon={tab.icon}
      label={tab.label}
      role="toggle"
      active={activeTool === tab.id}
      onClick={() => onToggle(tab.id)}
      contextItems={railItems(tab)}
    />
  );

  const renderWorkspace = (tab: TabDef) => (
    <RailButton
      key={tab.id}
      icon={tab.icon}
      label={tab.label}
      role="tab"
      active={activeSurface === tab.id}
      onClick={() => onSelectSurface(tab.id)}
      contextItems={railItems(tab)}
    />
  );

  return (
    <>
      <RailContainer side="left" aria-label="Project tool windows">
        {LEFT_TOOL_TABS.map((tab) => (
          <Fragment key={tab.id}>
            {tab.separatorBefore && <RailSeparator />}
            {renderTool(tab)}
          </Fragment>
        ))}
        {WORKSPACE_SURFACES.filter((tab) => tab.id !== 'preview' || previewEnabled).map((tab) => (
          <Fragment key={tab.id}>
            {tab.separatorBefore && <RailSeparator />}
            {renderWorkspace(tab)}
          </Fragment>
        ))}
        {pluginTabs.length > 0 && <RailSeparator />}
        {pluginTabs.map(renderTool)}
        <div className="mt-auto flex flex-col items-center gap-0.5 pb-1">
          <LinkDesignSystemDialog projectId={projectId} />
          <RailButton
            icon={Settings2}
            label={t('settings.open')}
            active={false}
            disabled={!project}
            onClick={() => setSettingsOpen(true)}
          />
          <RailButton
            icon={TerminalSquare}
            label="Terminal (Alt+F12)"
            role="toggle"
            active={bottomOpen}
            onClick={onToggleBottom}
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
