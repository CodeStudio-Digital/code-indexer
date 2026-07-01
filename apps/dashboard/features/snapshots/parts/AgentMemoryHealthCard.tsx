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

interface AgentMemoryStats {
  liveProject: number;
  liveUser: number;
  events: Record<string, number>;
  recallHits: number;
  recallEmpty: number;
}

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
    </div>
  );
}
