import { useApi } from '../../../hooks/useApi.js';
import { cn } from '../../../lib/utils.js';
import type { LayerOverview } from '../types.js';

interface ArchitectureTabProps {
  projectId: number;
}

const LAYER_COLORS: Record<string, string> = {
  presentation: 'bg-info',
  business: 'bg-success',
  data: 'bg-warning',
  infrastructure: 'bg-primary',
  config: 'bg-muted-foreground',
  test: 'bg-warning',
  unknown: 'bg-muted-foreground/50',
};

export function ArchitectureTab({ projectId }: ArchitectureTabProps) {
  const { data: layers, loading } = useApi<LayerOverview[]>(`/projects/${projectId}/architecture`);
  if (loading) return <div className="text-muted-foreground text-sm">Loading…</div>;
  if (!layers || layers.length === 0)
    return <div className="text-muted-foreground text-sm">No architecture data.</div>;
  const maxCount = Math.max(...layers.map((l) => l.count));
  return (
    <div className="space-y-3">
      <h3 className="font-semibold mb-2">Files by Layer</h3>
      {layers.map((l) => (
        <div key={l.layer} className="flex items-center gap-3">
          <span className="w-32 text-sm font-medium capitalize">{l.layer}</span>
          <div className="flex-1 bg-muted rounded-full h-6 overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                LAYER_COLORS[l.layer] ?? 'bg-muted-foreground/50',
              )}
              style={{ width: `${(l.count / maxCount) * 100}%` }}
            />
          </div>
          <span className="w-12 text-sm text-right text-muted-foreground tabular-nums">{l.count}</span>
        </div>
      ))}
    </div>
  );
}
