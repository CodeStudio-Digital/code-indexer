import { cn } from '../../lib/utils.js';
import { WorkbenchTabStrip } from '../../components/workbench/index.js';
import { PRIMARY_SURFACES, type TabDef } from './tabs-config.js';

interface ProjectSurfaceBarProps {
  active: string;
  onSelect: (id: string) => void;
  previewEnabled: boolean;
}

export function ProjectSurfaceBar({ active, onSelect, previewEnabled }: ProjectSurfaceBarProps) {
  const surfaces = PRIMARY_SURFACES.filter((surface) => surface.id !== 'preview' || previewEnabled);
  return (
    <WorkbenchTabStrip
      aria-label="Primary workspace surfaces"
      className="overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {surfaces.map((surface: TabDef) => {
        const Icon = surface.icon;
        const selected = active === surface.id;
        return (
          <button
            key={surface.id}
            type="button"
            data-workbench-surface={surface.id}
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(surface.id)}
            className={cn(
              'relative flex h-8 shrink-0 items-center gap-1.5 border-r border-[var(--workbench-border)] px-3 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--workbench-focus)]',
              selected
                ? 'bg-[var(--workbench-raised)] text-foreground'
                : 'text-muted-foreground hover:bg-[var(--workbench-hover)] hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{surface.label}</span>
            {selected && <span className="absolute inset-x-2 top-0 h-0.5 rounded-b bg-[var(--workbench-focus)]" />}
          </button>
        );
      })}
    </WorkbenchTabStrip>
  );
}
