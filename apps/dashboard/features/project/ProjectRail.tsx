/**
 * Activity rail vertical do ProjectView — ícones core/analytics/plugins + toggle de
 * terminal. Extraído do ProjectView (W4 decompose). A config das abas vem do tabs-config.
 */
import { TerminalSquare } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js';
import { useWorkspaceLayout } from '../../state/workspace-layout.js';
import { LinkDesignSystemDialog } from './builder/LinkDesignSystemDialog.js';
import { TABS, type ProjectTabId, type TabDef } from './tabs-config.js';

interface ProjectRailProps {
  projectId: number;
  activeTab: ProjectTabId;
  onSelect: (id: ProjectTabId) => void;
  layout: ReturnType<typeof useWorkspaceLayout>;
  pluginTabs: TabDef[];
  /** Conditional core tabs (e.g. Preview, shown when a dev server runs). */
  extraCoreTabs?: TabDef[];
}

export function ProjectRail({ projectId, activeTab, onSelect, layout, pluginTabs, extraCoreTabs = [] }: ProjectRailProps) {
  const core = TABS.filter((t) => t.group === 'core');
  const analytics = TABS.filter((t) => t.group === 'analytics');
  return (
    <nav
      className="flex flex-col w-10 shrink-0 border-r bg-card/40 py-1 gap-0.5 items-center"
      aria-label="Project sections"
    >
      {core.map((tabDef) => (
        <RailButton key={tabDef.id} def={tabDef} active={activeTab === tabDef.id} onSelect={onSelect} />
      ))}
      {extraCoreTabs.map((tabDef) => (
        <RailButton key={tabDef.id} def={tabDef} active={activeTab === tabDef.id} onSelect={onSelect} />
      ))}
      <span className="h-px w-6 bg-border my-1.5" aria-hidden />
      {analytics.map((tabDef) => (
        <RailButton key={tabDef.id} def={tabDef} active={activeTab === tabDef.id} onSelect={onSelect} />
      ))}
      {pluginTabs.length > 0 && <span className="h-px w-6 bg-border my-1.5" aria-hidden />}
      {pluginTabs.map((tabDef) => (
        <RailButton key={tabDef.id} def={tabDef} active={activeTab === tabDef.id} onSelect={onSelect} />
      ))}
      <div className="mt-auto pb-1 flex flex-col items-center gap-0.5">
        {/* Project-scoped action: link a Design System (auto-hides on
            non-builder projects). Lives in the rail footer since the old
            ProjectTopBar that hosted it was removed. */}
        <LinkDesignSystemDialog projectId={projectId} />
        {/* Terminal toggle — sits at the bottom of the rail mirroring
            VS Code / JetBrains conventions. Active state reflects
            whether the bottom panel is currently open. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => layout.setActiveBottom(layout.activeBottom ? null : 'terminal')}
              aria-label="Toggle terminal"
              aria-pressed={layout.activeBottom !== null}
              className={cn(
                'relative h-8 w-8 grid place-items-center rounded-md transition-colors',
                layout.activeBottom
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <TerminalSquare className="h-4 w-4" />
              {layout.activeBottom && (
                <span
                  aria-hidden
                  className="absolute -left-1 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary"
                />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Terminal (Ctrl+J)</TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}

function RailButton({
  def,
  active,
  onSelect,
}: {
  def: TabDef;
  active: boolean;
  onSelect: (id: ProjectTabId) => void;
}) {
  const Icon = def.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onSelect(def.id)}
          aria-label={def.label}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'relative h-8 w-8 grid place-items-center rounded-md transition-colors',
            active
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          <Icon className="h-4 w-4" />
          {active && (
            <span
              aria-hidden
              className="absolute -left-1 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary"
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{def.label}</TooltipContent>
    </Tooltip>
  );
}
