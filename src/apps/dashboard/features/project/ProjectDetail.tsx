import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BookOpen,
  Boxes,
  DollarSign,
  FileCode2,
  Files,
  GitCompare,
  Hash,
  History,
  Layers,
  MessageSquareCode,
  Network,
  PlayCircle,
  Search,
} from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { useApi } from '../../hooks/useApi.js';
import AgentChat from '../chat/index.js';
import CostDashboard from '../costs/index.js';
import DiffViewer from '../diff/index.js';
import SearchPanel from '../search/index.js';
import SnapshotEditor from '../snapshots/index.js';
import { StatCard } from './StatCard.js';
import { ArchitectureTab } from './tabs/ArchitectureTab.js';
import { DependenciesTab } from './tabs/DependenciesTab.js';
import { FilesTab } from './tabs/FilesTab.js';
import { RunsTab } from './tabs/RunsTab.js';
import type { Stats } from './types.js';

interface ProjectDetailProps {
  projectId: number;
  projectName: string;
  /** When set (via Recent Sessions click), forces the chat tab and pre-selects
   *  the given session inside AgentChat. */
  initialSessionId?: number;
}

const TABS = [
  { id: 'chat', labelKey: 'detail.tabs.chat', icon: MessageSquareCode },
  { id: 'search', labelKey: 'detail.tabs.search', icon: Search },
  { id: 'files', labelKey: 'detail.tabs.files', icon: Files },
  { id: 'dependencies', labelKey: 'detail.tabs.deps', icon: Network },
  { id: 'architecture', labelKey: 'detail.tabs.arch', icon: Layers },
  { id: 'snapshots', labelKey: 'detail.tabs.snapshots', icon: BookOpen },
  { id: 'diff', labelKey: 'detail.tabs.diff', icon: GitCompare },
  { id: 'costs', labelKey: 'detail.tabs.costs', icon: DollarSign },
  { id: 'runs', labelKey: 'detail.tabs.runs', icon: History },
] as const;

export default function ProjectDetail({
  projectId,
  projectName,
  initialSessionId,
}: ProjectDetailProps) {
  const { t } = useTranslation('projects');
  const [tab, setTab] = useState<string>('chat');
  const { data: stats } = useApi<Stats>(`/projects/${projectId}/stats`);

  // A recent-session click should always land on the chat tab.
  useEffect(() => {
    if (initialSessionId) setTab('chat');
  }, [initialSessionId]);

  return (
    <div className="space-y-6">
      <Tabs value={tab} onValueChange={setTab} className="w-full">
        {/* Segmented pill navigation. Horizontal scroll on narrow viewports
            instead of wrapping, so the selected pill stays at a predictable
            vertical position. */}
        <div className="overflow-x-auto scrollbar-thin pb-1 -mx-1">
          <TabsList className="h-11 gap-1 p-1 bg-muted rounded-full w-fit mx-1">
            {TABS.map((tabDef) => {
              const Icon = tabDef.icon;
              return (
                <TabsTrigger
                  key={tabDef.id}
                  value={tabDef.id}
                  className="rounded-full h-9 px-4 gap-2 text-sm font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md"
                >
                  <Icon className="h-4 w-4" />
                  {t(tabDef.labelKey)}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>

        <TabsContent value="chat" className="mt-4 focus-visible:ring-0">
          <AgentChat
            projectId={projectId}
            projectName={projectName}
            initialSessionId={initialSessionId}
          />
        </TabsContent>
        <TabsContent value="search">
          <Card>
            <CardContent className="p-6">
              {stats && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                    <StatCard icon={FileCode2} label={t('detail.stats.files')} value={stats.file_count.toLocaleString()} />
                    <StatCard icon={Boxes} label={t('detail.stats.symbols')} value={stats.symbol_count.toLocaleString()} />
                    <StatCard icon={Hash} label={t('detail.stats.lines')} value={stats.total_lines.toLocaleString()} />
                    <StatCard icon={PlayCircle} label={t('detail.stats.runs')} value={stats.run_count} />
                  </div>
              )}
              <hr/>

              <SearchPanel projectId={projectId} projectName={projectName} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="files">
          <Card>
            <CardContent className="p-6">
              <FilesTab projectId={projectId} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="dependencies">
          <Card>
            <CardContent className="p-6">
              <DependenciesTab projectId={projectId} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="architecture">
          <Card>
            <CardContent className="p-6">
              <ArchitectureTab projectId={projectId} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="snapshots">
          <Card>
            <CardContent className="p-6">
              <SnapshotEditor projectId={projectId} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="diff">
          <Card>
            <CardContent className="p-6">
              <DiffViewer projectId={projectId} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="costs">
          <Card>
            <CardContent className="p-6">
              <CostDashboard projectId={projectId} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="runs">
          <Card>
            <CardContent className="p-6">
              <RunsTab projectId={projectId} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
