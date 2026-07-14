/**
 * Rail vertical de ícones do DS Studio (estilo ProjectRail): Preview |
 * Versões | Componentes | Docs num único strip na borda direita. Clicar o
 * ícone ativo recolhe o painel de conteúdo (toggle no pai); os dados dos
 * panels vêm do `detail` compartilhado (polling 5s na view).
 */
import { useTranslation } from 'react-i18next';
import { BookOpen, Boxes, History, ListChecks, Monitor, type LucideIcon } from 'lucide-react';
import { RailButton, RailContainer } from '../../../components/chrome/index.js';
import type { DesignSystemSessionDetail } from '../design-system-api.js';
import { VersionsPanel } from './VersionsPanel.js';
import { ComponentsPanel } from './ComponentsPanel.js';
import { DocsPanel } from './DocsPanel.js';
import { StagesPanel } from './StagesPanel.js';

export type DsStudioTab = 'stages' | 'preview' | 'versions' | 'components' | 'docs';

const TABS: Array<{ id: DsStudioTab; icon: LucideIcon; labelKey: string }> = [
  { id: 'stages', icon: ListChecks, labelKey: 'tabs.stages' },
  { id: 'preview', icon: Monitor, labelKey: 'tabs.preview' },
  { id: 'versions', icon: History, labelKey: 'tabs.versions' },
  { id: 'components', icon: Boxes, labelKey: 'tabs.components' },
  { id: 'docs', icon: BookOpen, labelKey: 'tabs.docs' },
];

export function DsStudioRail({
  active,
  onSelect,
}: {
  active: DsStudioTab | null;
  /** Recebe o id clicado; o pai alterna (clicar o ativo recolhe). */
  onSelect: (tab: DsStudioTab) => void;
}) {
  const { t } = useTranslation('designSystems');
  return (
    <RailContainer side="right" aria-label={t('studio.railAria')}>
      {TABS.map(({ id, icon: Icon, labelKey }) => {
        const isActive = active === id;
        return (
          <RailButton
            key={id}
            icon={Icon}
            label={t(labelKey)}
            side="right"
            role="toggle"
            active={isActive}
            onClick={() => onSelect(id)}
          />
        );
      })}
    </RailContainer>
  );
}

/** Conteúdo das abas de dados (o preview é renderizado pela própria view). */
export function DsStudioTabContent({
  tab,
  detail,
  onChanged,
}: {
  tab: Exclude<DsStudioTab, 'preview'>;
  detail: DesignSystemSessionDetail;
  onChanged: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'stages' && <StagesPanel detail={detail} onChanged={onChanged} />}
        {tab === 'versions' && <VersionsPanel detail={detail} onChanged={onChanged} />}
        {tab === 'components' && <ComponentsPanel detail={detail} />}
        {tab === 'docs' && <DocsPanel detail={detail} />}
      </div>
    </div>
  );
}
