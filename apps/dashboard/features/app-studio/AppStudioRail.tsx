/**
 * Rail vertical do App Studio — MESMO padrão de sistema do DsStudioRail
 * (ícones w-8 + tooltip + pill de ativo na borda), com as 4 abas do modo
 * leigo: Guia | Seu app | Seus dados | Publicar. "Seus dados" fica
 * desabilitado até a etapa database sair de pending.
 */
import { useTranslation } from 'react-i18next';
import { Database, Globe, ListChecks, Monitor, Workflow, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js';
import type { AppStudioSessionDetail } from './app-studio-api.js';
import { JourneyPanel } from './guide/JourneyPanel.js';
import { DataPanel, dataTabUnlocked } from './data/DataPanel.js';
import { PublishPanel } from './publish/PublishPanel.js';
import { BlueprintPanel } from './blueprint/BlueprintPanel.js';

export type AppStudioTab = 'guide' | 'blueprint' | 'preview' | 'data' | 'publish';

const TABS: Array<{ id: AppStudioTab; icon: LucideIcon; labelKey: string }> = [
  { id: 'guide', icon: ListChecks, labelKey: 'tabs.guide' },
  { id: 'blueprint', icon: Workflow, labelKey: 'tabs.blueprint' },
  { id: 'preview', icon: Monitor, labelKey: 'tabs.preview' },
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
      className="flex w-10 shrink-0 flex-col items-center gap-0.5 border-l bg-card/40 py-1"
      aria-label={t('tabs.guide')}
    >
      {TABS.map(({ id, icon: Icon, labelKey }) => {
        const isActive = active === id;
        const disabled =
          (id === 'data' && !dataTabUnlocked(detail)) ||
          (id === 'blueprint' && !detail?.spec);
        const label =
          disabled && id === 'data' ? t('data.locked')
          : disabled && id === 'blueprint' ? t('blueprint.locked')
          : t(labelKey);
        return (
          <Tooltip key={id}>
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
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
                {isActive && (
                  <span aria-hidden className="absolute -right-1 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">{label}</TooltipContent>
          </Tooltip>
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
}: {
  tab: Exclude<AppStudioTab, 'preview'>;
  detail: AppStudioSessionDetail;
  discoveryExtra?: string | null;
  onChanged: () => void;
  onOpenPublish: () => void;
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
          />
        )}
        {tab === 'blueprint' && <BlueprintPanel detail={detail} onChanged={onChanged} />}
        {tab === 'data' && <DataPanel detail={detail} />}
        {tab === 'publish' && <PublishPanel detail={detail} onChanged={onChanged} />}
      </div>
    </div>
  );
}
