import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ChartNoAxesCombined, Compass, Ellipsis, Gauge, GitCompare, Library, MonitorPlay, Network, ScrollText, Settings, Workflow } from 'lucide-react';
import { pluginWindowIcon } from '../../workspace/plugin-icon.js';
import type { ContribToolWindow } from '../../../state/contribution-registry.js';
import type { RightPanelId } from './types.js';
import type { SessionData } from '../types.js';
import { RailButton, RailContainer, RailSeparator } from '../../../components/chrome/index.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../../../components/ui/dropdown-menu.js';
import { useAgentCurrentTurn } from '../../../hooks/useAgentStream.js';
import { collectListedGroups, collectPersistedGroups } from './subagents-panel-data.js';
import { cn } from '../../../lib/utils.js';

interface ChatRightRailProps {
  sessionId: string;
  activePanelId: RightPanelId | null;
  onSelectPanel: (id: RightPanelId | null) => void;
  onOpenSnapshots?: () => void;
  /** Pending change hunks, not files. */
  pendingSnapshots?: number;
  pluginWindows?: ContribToolWindow[];
  previewAvailable?: boolean;
  subagentsAvailable?: boolean;
  activeSubagentCount?: number;
}

/** Keep the streaming subscription in this small rail, outside the chat layout. */
export function LiveChatRightRail({ sessionData, ...props }: ChatRightRailProps & { sessionData: SessionData | null }) {
  const turn = useAgentCurrentTurn(props.sessionId);
  const scopedData = sessionData?.session.id === props.sessionId ? sessionData : null;
  // A streamed text delta must not reparse the entire saved conversation.
  const history = useMemo(() => collectPersistedGroups(scopedData), [scopedData]);
  const groups = useMemo(() => collectListedGroups(scopedData, turn, history), [scopedData, turn, history]);
  const activeCount = groups.activeGroups.reduce((count, entry) =>
    count + entry.group.agents.filter((agent) => agent.status === 'running').length, 0);
  return <ChatRightRail {...props} subagentsAvailable={groups.activeGroups.length + groups.recentGroups.length > 0} activeSubagentCount={activeCount} />;
}

/** Primary session surfaces stay visible; specialist tools remain in More. */
export const ChatRightRail = memo(function ChatRightRail({
  sessionId, activePanelId, onSelectPanel, onOpenSnapshots, pendingSnapshots = 0,
  pluginWindows = [], previewAvailable = false, subagentsAvailable = false, activeSubagentCount = 0,
}: ChatRightRailProps) {
  const { t } = useTranslation('chat');
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => setMoreOpen(false), [sessionId]);
  const stateActive = activePanelId === 'meta' || activePanelId === 'plans';
  const contextActive = activePanelId === 'drive' || activePanelId === 'chapters';
  const showSubagents = subagentsAvailable || activePanelId === 'subagents';
  const moreActive = activePanelId != null && !stateActive && !contextActive
    && !['config', 'notifications', 'subagents', 'collaboration', 'usage-quota'].includes(activePanelId);
  const toggle = (id: RightPanelId, active = activePanelId === id) => onSelectPanel(active ? null : id);
  const advanced = [
    { id: 'insights' as const, icon: ChartNoAxesCombined, label: t('rightRail.insights') },
    { id: 'worker-log' as const, icon: ScrollText, label: t('rightRail.workerLog') },
    { id: 'subagents' as const, icon: Bot, label: t('rightRail.subagents') },
    { id: 'diagram' as const, icon: Workflow, label: t('rightRail.diagram') },
    ...(previewAvailable ? [{ id: 'preview' as const, icon: MonitorPlay, label: t('rightRail.preview') }] : []),
  ];
  const plugins = pluginWindows.filter((window) => window.side === 'right');
  return (
    <RailContainer side="right" aria-label={t('rightRail.sessionTools')}>
      <RailButton icon={Compass} label={t('rightRail.state')} side="right" role="toggle"
        active={stateActive} onClick={() => toggle('meta', stateActive)} />
      <RailButton icon={Library} label={t('rightRail.context')} side="right" role="toggle"
        active={contextActive} onClick={() => toggle('drive', contextActive)} />
      <RailButton icon={Network} label={t('collaboration.title')} side="right" role="toggle"
        active={activePanelId === 'collaboration'} onClick={() => toggle('collaboration')} />
      <RailButton icon={GitCompare} label={pendingSnapshots > 0
        ? t('rightRail.pendingChanges', { count: pendingSnapshots }) : t('rightRail.changes')}
        side="right" active={false} onClick={() => onOpenSnapshots?.()} disabled={!onOpenSnapshots} badge={pendingSnapshots} />
      <RailButton icon={Gauge} label={t('rightRail.usageQuota')} side="right" role="toggle"
        active={activePanelId === 'usage-quota'} onClick={() => toggle('usage-quota')} />
      <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={t('rightRail.more')} title={t('rightRail.more')}
            className={cn('relative grid h-8 w-8 shrink-0 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              moreActive || moreOpen ? 'bg-[var(--workbench-active)] text-foreground' : 'text-muted-foreground hover:bg-[var(--workbench-hover)] hover:text-foreground')}>
            <Ellipsis className="h-4 w-4" />
            {moreActive && <span aria-hidden className="absolute -right-1 top-1.5 bottom-1.5 w-0.5 rounded-full bg-[var(--workbench-focus)]" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="left" align="start" className="w-64 max-h-[70vh] overflow-y-auto">
          <DropdownMenuLabel>{t('rightRail.advanced')}</DropdownMenuLabel>
          {advanced.map(({ id, icon: Icon, label }) => (
            <DropdownMenuItem key={id} onSelect={() => onSelectPanel(id)} aria-current={activePanelId === id ? 'page' : undefined}>
              <Icon />{label}
            </DropdownMenuItem>
          ))}
          {plugins.length > 0 && <>
            <DropdownMenuSeparator /><DropdownMenuLabel>{t('rightRail.projectTools')}</DropdownMenuLabel>
            {plugins.map((window) => {
              const Icon = pluginWindowIcon(window.icon);
              const id = ('plugin:' + window.pluginNs + ':' + window.id) as RightPanelId;
              return <DropdownMenuItem key={id} onSelect={() => onSelectPanel(id)} aria-current={activePanelId === id ? 'page' : undefined}>
                <Icon />{window.title}
              </DropdownMenuItem>;
            })}
          </>}
        </DropdownMenuContent>
      </DropdownMenu>
      {showSubagents && <><RailSeparator /><RailButton icon={Bot} label={activeSubagentCount > 0
        ? t('rightRail.activeSubagents', { count: activeSubagentCount }) : t('rightRail.subagents')}
        side="right" role="toggle" active={activePanelId === 'subagents'} onClick={() => toggle('subagents')} badge={activeSubagentCount} /></>}
      <div className="mt-auto flex flex-col items-center gap-0.5 pt-1">
        <RailSeparator />
        <RailButton icon={Settings} label={t('rightRail.config')} side="right" role="toggle"
          active={activePanelId === 'config'} onClick={() => toggle('config')} />
      </div>
    </RailContainer>
  );
});
