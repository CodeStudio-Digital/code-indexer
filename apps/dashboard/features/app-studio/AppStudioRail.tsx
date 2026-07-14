/** Navegação das superfícies persistentes da jornada App Studio. */
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Boxes, Database, GitBranch, Globe, Layers3, ListChecks, Monitor, Palette, Workflow, type LucideIcon } from 'lucide-react';
import { RailButton, RailContainer, RailSeparator } from '../../components/chrome/index.js';
import type { AppStudioSessionDetail } from './app-studio-api.js';
import { JourneyPanel } from './guide/JourneyPanel.js';
import { DataPanel, dataTabUnlocked } from './data/DataPanel.js';
import { PublishPanel } from './publish/PublishPanel.js';
import { BlueprintPanel } from './blueprint/BlueprintPanel.js';
import { VersionsPanel } from './versions/VersionsPanel.js';
import { ArchitecturePanel } from './architecture/ArchitecturePanel.js';
import { ExperiencePanel } from './experience/ExperiencePanel.js';
import { ProductPanel } from './product/ProductPanel.js';

export type AppStudioTab = 'guide' | 'product' | 'blueprint' | 'versions' | 'architecture' | 'experience' | 'preview' | 'data' | 'publish';

export const APP_STUDIO_RAIL_TABS: Array<{ id: AppStudioTab; icon: LucideIcon; labelKey: string; separated?: boolean }> = [
  // Definição: acompanha a ordem natural da jornada, do geral ao específico.
  { id: 'guide', icon: ListChecks, labelKey: 'tabs.guide' },
  { id: 'product', icon: Layers3, labelKey: 'tabs.product' },
  { id: 'blueprint', icon: Workflow, labelKey: 'tabs.blueprint' },
  { id: 'architecture', icon: Boxes, labelKey: 'tabs.architecture' },
  { id: 'experience', icon: Palette, labelKey: 'tabs.experience' },
  { id: 'versions', icon: GitBranch, labelKey: 'tabs.versions' },
  // Execução: o app em funcionamento e os dados que o sustentam.
  { id: 'preview', icon: Monitor, labelKey: 'tabs.preview', separated: true },
  { id: 'data', icon: Database, labelKey: 'tabs.data' },
  // Entrega: ação final, visualmente isolada das ferramentas de construção.
  { id: 'publish', icon: Globe, labelKey: 'tabs.publish', separated: true },
];

export function AppStudioRail({
  active,
  detail,
  onSelect,
}: {
  active: AppStudioTab | null;
  detail: AppStudioSessionDetail | null;
  /** Recebe o id clicado; o pai alterna (clicar o ativo recolhe). */
  onSelect: (tab: AppStudioTab) => void;
}) {
  const { t } = useTranslation('appStudio');
  return (
    <RailContainer side="left" aria-label="App Studio tool windows">
      {APP_STUDIO_RAIL_TABS.map(({ id, icon: Icon, labelKey, separated }) => {
        const isActive = active === id;
        const disabled =
          (id === 'data' && !dataTabUnlocked(detail)) ||
          ((id === 'product' || id === 'blueprint' || id === 'versions' || id === 'architecture') && !detail?.spec);
        const experienceLocked = id === 'experience' && !detail?.workflow.state.phases.find((phase) => phase.id === 'blueprint' && phase.status !== 'locked');
        const label =
          disabled && id === 'data' ? t('data.locked')
          : disabled && id === 'blueprint' ? t('blueprint.locked')
          : disabled && id === 'versions' ? t('versions.locked')
          : disabled && id === 'architecture' ? t('architecture.locked')
          : t(labelKey);
        return (
          <Fragment key={id}>
            {separated && <RailSeparator />}
            <RailButton
              icon={Icon}
              label={label}
              role="toggle"
              active={isActive}
              disabled={disabled || experienceLocked}
              onClick={() => onSelect(id)}
            />
          </Fragment>
        );
      })}
    </RailContainer>
  );
}

/** Conteúdo das abas de dados (o preview é renderizado pela própria view). */
export function AppStudioTabContent({
  tab,
  detail,
  onChanged,
}: {
  tab: Exclude<AppStudioTab, 'preview'>;
  detail: AppStudioSessionDetail;
  onChanged: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--workbench-surface)]">
      <div className={`min-h-0 flex-1 ${tab === 'guide' ? 'overflow-hidden' : 'overflow-auto'}`}>
        {tab === 'guide' && (
          <JourneyPanel detail={detail} onChanged={onChanged} />
        )}
        {tab === 'blueprint' && <BlueprintPanel detail={detail} onChanged={onChanged} />}
        {tab === 'versions' && <VersionsPanel detail={detail} onChanged={onChanged} />}
        {tab === 'architecture' && <ArchitecturePanel detail={detail} onChanged={onChanged} />}
        {tab === 'product' && <ProductPanel detail={detail} onChanged={onChanged} />}
        {tab === 'experience' && <ExperiencePanel detail={detail} onChanged={onChanged} />}
        {tab === 'data' && <DataPanel detail={detail} onChanged={onChanged} />}
        {tab === 'publish' && <PublishPanel detail={detail} onChanged={onChanged} />}
      </div>
    </div>
  );
}
