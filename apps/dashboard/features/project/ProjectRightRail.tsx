import { RailButton, RailContainer, RailSeparator } from '../../components/chrome/index.js';
import { useTranslation } from 'react-i18next';
import { RIGHT_TOOL_TABS, type TabDef } from './tabs-config.js';

interface ProjectRightRailProps {
  activeTool: string | null;
  onToggle: (id: string) => void;
  pluginTabs: TabDef[];
  hideChat?: boolean;
  tabs?: TabDef[];
}

export function ProjectRightRail({ activeTool, onToggle, pluginTabs, hideChat = false, tabs = RIGHT_TOOL_TABS }: ProjectRightRailProps) {
  const { t } = useTranslation('projects');
  const renderTool = (tab: TabDef) => (
    <RailButton
      key={tab.id}
      icon={tab.icon}
      label={tab.label}
      side="right"
      role="toggle"
      active={activeTool === tab.id}
      onClick={() => onToggle(tab.id)}
    />
  );

  return (
    <RailContainer side="right" aria-label={t('rail.contextTools')}>
      {tabs.filter((tab) => !hideChat || tab.id !== 'chat').map(renderTool)}
      {pluginTabs.length > 0 && <RailSeparator />}
      {pluginTabs.map(renderTool)}
    </RailContainer>
  );
}
