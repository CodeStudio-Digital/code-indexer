import { useEffect, useState } from 'react';
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
  { id: 'chat', label: 'Chat', icon: MessageSquareCode },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'files', label: 'Files', icon: Files },
  { id: 'dependencies', label: 'Deps', icon: Network },
  { id: 'architecture', label: 'Arch', icon: Layers },
  { id: 'snapshots', label: 'Snapshots', icon: BookOpen },
  { id: 'diff', label: 'Diff', icon: GitCompare },
  { id: 'costs', label: 'Costs', icon: DollarSign },
  { id: 'runs', label: 'Runs', icon: History },
] as const;

export default function ProjectDetail({
  projectId,
  projectName,
  initialSessionId,
}: ProjectDetailProps) {
  const [tab, setTab] = useState<string>('chat');
  const { data: stats } = useApi<Stats>(`/projects/${projectId}/stats`);

  // A recent-session click should always land on the chat tab.
  useEffect(() => {
    if (initialSessionId) setTab('chat');
  }, [initialSessionId]);

  return (
    <div className="space-y-6">
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard icon={FileCode2} label="Files" value={stats.file_count.toLocaleString()} />
          <StatCard icon={Boxes} label="Symbols" value={stats.symbol_count.toLocaleString()} />
          <StatCard icon={Hash} label="Lines" value={stats.total_lines.toLocaleString()} />
          <StatCard icon={PlayCircle} label="Runs" value={stats.run_count} />
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        {/* Segmented pill navigation. Horizontal scroll on narrow viewports
            instead of wrapping, so the selected pill stays at a predictable
            vertical position. */}
        <div className="overflow-x-auto scrollbar-thin pb-1 -mx-1">
          <TabsList className="h-11 gap-1 p-1 bg-muted rounded-full w-fit mx-1">
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <TabsTrigger
                  key={t.id}
                  value={t.id}
                  className="rounded-full h-9 px-4 gap-2 text-sm font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md"
                >
                  <Icon className="h-4 w-4" />
                  {t.label}
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
