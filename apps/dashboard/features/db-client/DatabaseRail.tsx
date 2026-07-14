import { Bookmark, Bot, Clock3, Database } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { WorkbenchTabStrip } from '../../components/workbench/WorkbenchChrome.js';
import { cn } from '../../lib/utils.js';

export type DatabaseTool = 'connections' | 'history' | 'saved' | 'specialist';

export function DatabaseToolTabs({
  active,
  connectionCount,
  historyDisabled,
  onToggle,
}: {
  active: DatabaseTool | null;
  connectionCount: number;
  historyDisabled: boolean;
  onToggle: (tool: DatabaseTool) => void;
}) {
  const { t } = useTranslation('dbClient');
  const tools = [
    { id: 'connections' as const, icon: Database, label: t('rail.connections'), badge: connectionCount || undefined },
    { id: 'history' as const, icon: Clock3, label: t('rail.history'), disabled: historyDisabled },
    { id: 'saved' as const, icon: Bookmark, label: t('rail.saved') },
    { id: 'specialist' as const, icon: Bot, label: t('rail.specialist'), disabled: connectionCount === 0 },
  ];

  return (
    <WorkbenchTabStrip aria-label={t('rail.label')} className="overflow-hidden">
      {tools.map((tool) => {
        const Icon = tool.icon;
        return (
          <button
            key={tool.id}
            type="button"
            role="tab"
            aria-label={tool.label}
            aria-selected={active === tool.id}
            title={tool.label}
            disabled={tool.disabled}
            onClick={() => onToggle(tool.id)}
            className={cn(
              'relative flex h-8 min-w-0 flex-1 items-center justify-center gap-1 border-r border-[var(--workbench-border)] text-muted-foreground transition-colors last:border-r-0',
              'focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--workbench-focus)]',
              'disabled:cursor-not-allowed disabled:opacity-35',
              active === tool.id
                ? 'bg-[var(--workbench-raised)] text-foreground'
                : 'hover:bg-[var(--workbench-hover)] hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            {tool.badge != null && (
              <span className="min-w-3 rounded bg-[var(--workbench-active)] px-1 text-center text-[9px] leading-4 text-foreground">
                {tool.badge > 99 ? '99+' : tool.badge}
              </span>
            )}
            {active === tool.id && (
              <span className="absolute inset-x-2 top-0 h-0.5 rounded-b bg-[var(--workbench-focus)]" />
            )}
          </button>
        );
      })}
    </WorkbenchTabStrip>
  );
}
