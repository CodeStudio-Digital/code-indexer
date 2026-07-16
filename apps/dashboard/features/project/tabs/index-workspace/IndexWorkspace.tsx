/**
 * Aba "Index" unificada do ProjectView. Junta numa só superfície tudo que é
 * faceta do índice real do projeto. Superfícies do antigo enriquecimento LLM
 * (Search duplicada, Architecture, Diff e Costs) não fazem parte deste fluxo.
 *
 * Host enxuto: uma faixa de status no topo + uma barra de sub-abas. Cada seção
 * reaproveita o componente já existente (nada reescrito); só a seção "Overview"
 * (controle de run + embeddings + histórico) veio da decomposição da RunsTab.
 */
import { Suspense, lazy, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, FileCode2, Loader2, Network } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '../../../../components/ui/tabs.js';
import { IndexHeaderStrip } from './IndexHeaderStrip.js';

const RunSection = lazy(() => import('./RunSection.js').then((m) => ({ default: m.RunSection })));
const IndexedFilesTab = lazy(() => import('../FilesTab.js').then((m) => ({ default: m.FilesTab })));
const DependenciesTab = lazy(() => import('../DependenciesTab.js').then((m) => ({ default: m.DependenciesTab })));

const SECTIONS = [
  { id: 'overview', icon: Database, labelKey: 'index.tab.overview' },
  { id: 'files', icon: FileCode2, labelKey: 'index.tab.files' },
  { id: 'dependencies', icon: Network, labelKey: 'index.tab.dependencies' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

function TabSpinner() {
  return (
    <div className="h-full grid place-items-center text-xs text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
    </div>
  );
}

export function IndexWorkspace({
  projectId,
  projectName,
  onOpenFile,
  initialSection,
}: {
  projectId: number;
  projectName: string;
  onOpenFile: (path: string) => void;
  initialSection?: string;
}) {
  const { t } = useTranslation('projects');
  const [section, setSection] = useState<SectionId>(
    SECTIONS.some((s) => s.id === initialSection) ? (initialSection as SectionId) : 'overview',
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <IndexHeaderStrip projectId={projectId} />
      <Tabs value={section} onValueChange={(v) => setSection(v as SectionId)} className="flex flex-col flex-1 min-h-0">
        <TabsList className="mx-4 mt-3 self-start max-w-full overflow-x-auto">
          {SECTIONS.map((s) => (
            <TabsTrigger key={s.id} value={s.id}>
              <s.icon className="h-3.5 w-3.5" />
              {t(s.labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="flex-1 min-h-0 overflow-auto px-4 py-3">
          <Suspense fallback={<TabSpinner />}>
            {section === 'overview' && (
              <RunSection projectId={projectId} projectName={projectName} onOpenFile={onOpenFile} />
            )}
            {section === 'files' && <IndexedFilesTab projectId={projectId} onOpenFile={onOpenFile} />}
            {section === 'dependencies' && <DependenciesTab projectId={projectId} />}
          </Suspense>
        </div>
      </Tabs>
    </div>
  );
}
