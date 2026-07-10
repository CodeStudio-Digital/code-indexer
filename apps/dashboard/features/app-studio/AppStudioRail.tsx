/**
 * Rail vertical do App Studio — ferramentas de palco à esquerda. Preview e
 * Mapa ficam no topo porque são as duas superfícies que um usuário leigo
 * entende primeiro: ver o app e ver a especificação em blocos.
 */
import { useTranslation } from 'react-i18next';
import { Boxes, Database, GitBranch, Globe, ListChecks, Monitor, Workflow, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js';
import type { AppStudioSessionDetail } from './app-studio-api.js';
import { JourneyPanel } from './guide/JourneyPanel.js';
import { DataPanel, dataTabUnlocked } from './data/DataPanel.js';
import { PublishPanel } from './publish/PublishPanel.js';
import { BlueprintPanel } from './blueprint/BlueprintPanel.js';
import { VersionsPanel } from './versions/VersionsPanel.js';
import { ArchitecturePanel } from './architecture/ArchitecturePanel.js';

export type AppStudioTab = 'guide' | 'blueprint' | 'versions' | 'architecture' | 'preview' | 'data' | 'publish';

const TABS: Array<{ id: AppStudioTab; icon: LucideIcon; labelKey: string; separated?: boolean }> = [
  { id: 'preview', icon: Monitor, labelKey: 'tabs.preview' },
  { id: 'blueprint', icon: Workflow, labelKey: 'tabs.blueprint' },
  { id: 'versions', icon: GitBranch, labelKey: 'tabs.versions' },
  { id: 'architecture', icon: Boxes, labelKey: 'tabs.architecture' },
  { id: 'guide', icon: ListChecks, labelKey: 'tabs.guide', separated: true },
  { id: 'data', icon: Database, labelKey: 'tabs.data' },
  { id: 'publish', icon: Globe, labelKey: 'tabs.publish' },
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
    <nav
      className="flex w-11 shrink-0 flex-col items-center gap-0.5 border-r bg-card/45 py-1.5"
      aria-label={t('tabs.guide')}
    >
      {TABS.map(({ id, icon: Icon, labelKey, separated }) => {
        const isActive = active === id;
        const disabled =
          (id === 'data' && !dataTabUnlocked(detail)) ||
          ((id === 'blueprint' || id === 'versions' || id === 'architecture') && !detail?.spec);
        const label =
          disabled && id === 'data' ? t('data.locked')
          : disabled && id === 'blueprint' ? t('blueprint.locked')
          : disabled && id === 'versions' ? t('versions.locked')
          : disabled && id === 'architecture' ? t('architecture.locked')
          : t(labelKey);
        return (
          <div key={id} className={cn('flex flex-col items-center', separated && 'mt-2 border-t pt-2')}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onSelect(id)}
                  aria-label={label}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'relative grid h-8 w-8 place-items-center rounded-md transition-colors',
                    isActive
                      ? 'bg-accent text-accent-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {isActive && (
                    <span aria-hidden className="absolute -left-1 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          </div>
        );
      })}
    </nav>
  );
}

/** Conteúdo das abas de dados (o preview é renderizado pela própria view). */
export function AppStudioTabContent({
  tab,
  detail,
  discoveryExtra,
  onChanged,
  onOpenPublish,
  onOpenSpecAgent,
  onOpenDbAgent,
  onOpenArchitectureAgent,
}: {
  tab: Exclude<AppStudioTab, 'preview'>;
  detail: AppStudioSessionDetail;
  discoveryExtra?: string | null;
  onChanged: () => void;
  onOpenPublish: () => void;
  onOpenSpecAgent?: (prompt: string) => void;
  onOpenDbAgent?: (prompt: string) => void;
  onOpenArchitectureAgent?: (prompt: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'guide' && (
          <JourneyPanel
            detail={detail}
            discoveryExtra={discoveryExtra}
            onChanged={onChanged}
            onOpenPublish={onOpenPublish}
            onOpenSpecAgent={onOpenSpecAgent}
            onOpenDbAgent={onOpenDbAgent}
            onOpenArchitectureAgent={onOpenArchitectureAgent}
          />
        )}
        {tab === 'blueprint' && <BlueprintPanel detail={detail} onChanged={onChanged} onOpenSpecAgent={onOpenSpecAgent} />}
        {tab === 'versions' && <VersionsPanel detail={detail} onChanged={onChanged} onOpenSpecAgent={onOpenSpecAgent} />}
        {tab === 'architecture' && <ArchitecturePanel detail={detail} onChanged={onChanged} onOpenAgent={onOpenArchitectureAgent} />}
        {tab === 'data' && <DataPanel detail={detail} onChanged={onChanged} onOpenDbAgent={onOpenDbAgent} />}
        {tab === 'publish' && <PublishPanel detail={detail} onChanged={onChanged} />}
      </div>
    </div>
  );
}
