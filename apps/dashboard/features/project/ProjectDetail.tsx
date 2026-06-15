import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Boxes,
  Brain,
  DollarSign,
  FileCode2,
  Files,
  FolderGit2,
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
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js';
import { useApi } from '../../hooks/useApi.js';
import { cn } from '../../lib/utils.js';
import AgentChat from '../chat/index.js';
import CostDashboard from '../costs/index.js';
import DiffViewer from '../diff/index.js';
import SearchPanel from '../search/index.js';
import SnapshotEditor from '../snapshots/index.js';
import { UserMemoryPanel } from '../user-memory/UserMemoryPanel.js';
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
  { id: 'snapshots', labelKey: 'detail.tabs.memory', icon: Brain },
  { id: 'diff', labelKey: 'detail.tabs.diff', icon: GitCompare },
  { id: 'costs', labelKey: 'detail.tabs.costs', icon: DollarSign },
  { id: 'runs', labelKey: 'detail.tabs.runs', icon: History },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function ProjectDetail({
  projectId,
  projectName,
  initialSessionId,
}: ProjectDetailProps) {
  const { t } = useTranslation('projects');
  const [tab, setTab] = useState<TabId>('chat');
  const { data: stats } = useApi<Stats>(`/projects/${projectId}/stats`);

  // A recent-session click should always land on the chat tab.
  useEffect(() => {
    if (initialSessionId) setTab('chat');
  }, [initialSessionId]);

  return (
    <div className="flex flex-col h-[100dvh] min-h-0">
      <ProjectTopBar projectName={projectName} />
      <div className="flex flex-1 min-h-0">
        <ProjectTabsRail activeTab={tab} onSelect={setTab} t={t} />
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
        {tab === 'chat' ? (
          <AgentChat
            projectId={projectId}
            projectName={projectName}
            initialSessionId={initialSessionId}
          />
        ) : (
          <div className="h-full overflow-y-auto px-3 py-4 sm:px-6 sm:py-6">
            {tab === 'search' && (
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
                  <hr />
                  <SearchPanel projectId={projectId} projectName={projectName} />
                </CardContent>
              </Card>
            )}
            {tab === 'files' && (
              <Card>
                <CardContent className="p-6">
                  <FilesTab projectId={projectId} />
                </CardContent>
              </Card>
            )}
            {tab === 'dependencies' && (
              <Card>
                <CardContent className="p-6">
                  <DependenciesTab projectId={projectId} />
                </CardContent>
              </Card>
            )}
            {tab === 'architecture' && (
              <Card>
                <CardContent className="p-6">
                  <ArchitectureTab projectId={projectId} />
                </CardContent>
              </Card>
            )}
            {tab === 'snapshots' && (
              <div className="space-y-4">
                <Card>
                  <CardContent className="p-6">
                    <SnapshotEditor projectId={projectId} />
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <UserMemoryPanel />
                  </CardContent>
                </Card>
              </div>
            )}
            {tab === 'diff' && (
              <Card>
                <CardContent className="p-6">
                  <DiffViewer projectId={projectId} />
                </CardContent>
              </Card>
            )}
            {tab === 'costs' && (
              <Card>
                <CardContent className="p-6">
                  <CostDashboard projectId={projectId} />
                </CardContent>
              </Card>
            )}
            {tab === 'runs' && (
              <Card>
                <CardContent className="p-6">
                  <RunsTab projectId={projectId} />
                </CardContent>
              </Card>
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

/**
 * Slim project-scoped top bar. Shows the open project's name on the left
 * and reserves the right-hand area for future menus (kept empty for now).
 */
function ProjectTopBar({ projectName }: { projectName: string }) {
  return (
    <header className="h-9 shrink-0 border-b bg-card/60 flex items-center px-3 gap-2">
      <FolderGit2 className="h-3.5 w-3.5 text-primary shrink-0" />
      <span className="text-xs font-medium truncate" title={projectName}>
        {projectName}
      </span>
      <div
        className="ml-auto flex items-center gap-1"
        aria-label="Project menu area"
      />
    </header>
  );
}

/**
 * Vertical icons-only rail rendered flush against the AppShell sidebar.
 * Each tab is a Tooltip-wrapped button — labels live in the tooltip so the
 * rail stays narrow and the chat area below gets maximum width.
 */
function ProjectTabsRail({
  activeTab,
  onSelect,
  t,
}: {
  activeTab: TabId;
  onSelect: (id: TabId) => void;
  t: (key: string) => string;
}) {
  return (
    <nav
      className="flex flex-col w-12 shrink-0 border-r bg-card/40 py-2 gap-0.5 items-center"
      aria-label="Project sections"
    >
      {TABS.map((tabDef) => {
        const Icon = tabDef.icon;
        const active = activeTab === tabDef.id;
        return (
          <Tooltip key={tabDef.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onSelect(tabDef.id)}
                aria-label={t(tabDef.labelKey)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative h-9 w-9 flex items-center justify-center rounded-md transition-colors',
                  active
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
                {active && (
                  <span
                    className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-primary"
                    aria-hidden="true"
                  />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{t(tabDef.labelKey)}</TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}
