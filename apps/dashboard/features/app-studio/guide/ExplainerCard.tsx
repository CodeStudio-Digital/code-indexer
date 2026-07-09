/**
 * Collapsible "O que é isso?" por etapa — explicação em linguagem simples
 * (i18n explainers.*). Collapsible em vez de tooltip: hover é
 * indescobrível para leigo.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, HelpCircle } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import type { AppStageId } from '../app-studio-api.js';

export function ExplainerCard({ stageId }: { stageId: AppStageId }) {
  const { t } = useTranslation('appStudio');
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border bg-muted/20 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-muted-foreground hover:text-foreground"
      >
        <HelpCircle className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">{t(`explainers.${stageId}.title`)}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <p className="px-2.5 pb-2 leading-relaxed text-muted-foreground">{t(`explainers.${stageId}.body`)}</p>}
    </div>
  );
}
