import { Card, CardContent } from '../../components/ui/card.js';
import { useApi } from '../../hooks/useApi.js';

interface CostSummary {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_embedding_tokens: number;
  runs: number;
  by_provider: Record<string, { cost_usd: number; input_tokens: number; output_tokens: number }>;
}

interface CostDashboardProps {
  projectId: number;
}

export default function CostDashboard({ projectId }: CostDashboardProps) {
  const { data: costs, loading } = useApi<CostSummary>(`/projects/${projectId}/costs`);

  if (loading) return <div className="text-muted-foreground text-sm">Loading costs…</div>;
  if (!costs) return <div className="text-muted-foreground text-sm">No cost data.</div>;

  const providers = Object.entries(costs.by_provider);
  const maxCost = Math.max(...providers.map(([, v]) => v.cost_usd), 0.001);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Cost" value={`$${costs.total_cost_usd.toFixed(4)}`} />
        <StatCard label="Input Tokens" value={costs.total_input_tokens.toLocaleString()} />
        <StatCard label="Output Tokens" value={costs.total_output_tokens.toLocaleString()} />
        <StatCard label="Runs" value={String(costs.runs)} />
      </div>

      {providers.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-3">Cost by Provider</h3>
          <div className="space-y-2">
            {providers.map(([name, data]) => (
              <div key={name} className="flex items-center gap-3">
                <span className="w-28 text-sm">{name}</span>
                <div className="flex-1 bg-muted rounded-full h-4 overflow-hidden">
                  <div
                    className="bg-primary h-full rounded-full transition-all"
                    style={{ width: `${(data.cost_usd / maxCost) * 100}%` }}
                  />
                </div>
                <span className="text-sm text-muted-foreground w-20 text-right tabular-nums">
                  ${data.cost_usd.toFixed(4)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="shadow-none">
      <CardContent className="p-4">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{label}</p>
        <p className="text-xl font-bold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}
