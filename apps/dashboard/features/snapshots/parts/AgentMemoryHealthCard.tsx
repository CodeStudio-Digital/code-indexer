/**
 * Agent Memory health card — sits beside MemoryHealthCard on the project Memory
 * surface and answers "is the dedicated agent_memory (migration 181) actually
 * being USED?". Shows live project/user memory counts + the decisive signal:
 * how many proactive recalls injected ≥1 memory (vs. came back empty), plus
 * save/forget telemetry. Read-only over GET /projects/:id/agent-memory/stats.
 */
import { useTranslation } from 'react-i18next';
import { Database, RefreshCw, Check } from 'lucide-react';
import { useApi } from '../../../hooks/useApi.js';
import { usePolling } from '../../../hooks/usePolling.js';

interface AgentMemoryKpis {
  windowDays: number;
  learningRate: number | null;
  sessionsInWindow: number;
  recallHitRate: number | null;
  recallsInWindow: number;
  usageCoverage: number | null;
  liveStock: number;
  goldStock: number;
  explicitCalls: Record<string, number>;
}

interface AgentMemoryStats {
  liveProject: number;
  liveUser: number;
  events: Record<string, number>;
  recallHits: number;
  recallEmpty: number;
  kpis?: AgentMemoryKpis;
}

const pct = (v: number | null): string => (v == null ? '—' : `${Math.round(v * 100)}%`);

export function AgentMemoryHealthCard({ projectId }: { projectId: number }) {
  const { t } = useTranslation('projects');
  const { data, refetch } = useApi<AgentMemoryStats>(`/projects/${projectId}/agent-memory/stats`);
  // Light live refresh so saves/recalls show up while you watch a session run.
  usePolling(() => refetch(), 8000, { immediate: false });

  if (!data) return null;
  const { liveProject, liveUser, events, recallHits, recallEmpty } = data;
  const used = recallHits > 0;

  return (
    <div className="border-b bg-muted/30 px-3 py-2 space-y-1.5 shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <Database className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="text-xs font-medium">{t('memory.agent.title')}</span>
        <span className="text-[10px] text-muted-foreground">
          {t('memory.agent.counts', { project: liveProject, user: liveUser })}
        </span>
        <button
          type="button"
          onClick={refetch}
          aria-label={t('memory.health.refresh')}
          className="p-1 rounded hover:bg-muted text-muted-foreground"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      <div className="text-[10px] flex items-center gap-1.5 min-w-0">
        {used ? (
          <span className="flex items-center gap-1 px-1 rounded font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
            <Check className="h-3 w-3 shrink-0" />
            {t('memory.agent.used', { hits: recallHits, empty: recallEmpty })}
          </span>
        ) : (
          <span className="text-muted-foreground">{t('memory.agent.dormant')}</span>
        )}
      </div>

      <div className="text-[10px] text-muted-foreground">
        {t('memory.agent.events', {
          remember: events.remember ?? 0,
          forget: events.forget ?? 0,
        })}
      </div>

      {data.kpis && (
        <div className="flex flex-wrap items-center gap-1">
          {([
            ['k1', t('memory.kpi.learning'), pct(data.kpis.learningRate), t('memory.kpi.learningTip', { sessions: data.kpis.sessionsInWindow, days: data.kpis.windowDays })],
            ['k2', t('memory.kpi.recallHit'), pct(data.kpis.recallHitRate), t('memory.kpi.recallHitTip', { recalls: data.kpis.recallsInWindow, days: data.kpis.windowDays })],
            ['k3', t('memory.kpi.coverage'), pct(data.kpis.usageCoverage), t('memory.kpi.coverageTip', { live: data.kpis.liveStock, days: data.kpis.windowDays })],
            ['k4', t('memory.kpi.gold'), String(data.kpis.goldStock), t('memory.kpi.goldTip')],
          ] as const).map(([key, label, value, tip]) => (
            <span
              key={key}
              title={tip}
              className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-muted text-muted-foreground"
            >
              {label} <span className="text-foreground">{value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
