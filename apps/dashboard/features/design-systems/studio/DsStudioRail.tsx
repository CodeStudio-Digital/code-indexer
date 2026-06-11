/**
 * Rail direito do DS Studio — Versões | Componentes | Docs sobre o estado
 * vivo da sessão DS (polling 5s; os dados mudam conforme o agente registra
 * componentes e publica). O detail é compartilhado com o header da view.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Boxes, History } from 'lucide-react';
import type { DesignSystemSessionDetail } from '../design-system-api.js';
import { VersionsPanel } from './VersionsPanel.js';
import { ComponentsPanel } from './ComponentsPanel.js';
import { DocsPanel } from './DocsPanel.js';

type RailTab = 'versions' | 'components' | 'docs';

export function DsStudioRail({
  detail,
  onChanged,
}: {
  detail: DesignSystemSessionDetail;
  onChanged: () => void;
}) {
  const { t } = useTranslation('designSystems');
  const [tab, setTab] = useState<RailTab>('versions');

  const button = (key: RailTab, icon: React.ReactNode, label: string) => (
    <button
      onClick={() => setTab(key)}
      className={`inline-flex flex-1 items-center justify-center gap-1.5 border-b-2 px-2 py-2 text-xs transition-colors ${
        tab === key
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {icon} {label}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex shrink-0 border-b">
        {button('versions', <History className="h-3.5 w-3.5" />, t('tabs.versions'))}
        {button('components', <Boxes className="h-3.5 w-3.5" />, t('tabs.components'))}
        {button('docs', <BookOpen className="h-3.5 w-3.5" />, t('tabs.docs'))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'versions' && <VersionsPanel detail={detail} onChanged={onChanged} />}
        {tab === 'components' && <ComponentsPanel detail={detail} />}
        {tab === 'docs' && <DocsPanel detail={detail} />}
      </div>
    </div>
  );
}
