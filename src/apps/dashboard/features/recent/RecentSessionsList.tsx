import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquareCode } from 'lucide-react';
import { useApi } from '../../hooks/useApi.js';
import { cn, formatRelativeTime } from '../../lib/utils.js';
import { providerAccent } from '../chat/constants.js';
import type { CoderSession } from '../chat/types.js';

type RecentSession = CoderSession & { project_name: string };

interface RecentSessionsListProps {
  onSelect: (projectId: number, projectName: string, sessionId: number) => void;
  activeSessionId: number | null;
  /** Limit of rows to render — fits the compact sidebar slot. */
  limit?: number;
}

/**
 * Cross-project recent sessions rendered inside the main app sidebar. Clicks
 * navigate to the project view with the chat tab pre-selecting the session.
 * Refetches automatically on any `coder:sessions-changed` window event —
 * dispatched by AgentChat after send/create/archive/favorite/fork/delete.
 */
export function RecentSessionsList({ onSelect, activeSessionId, limit = 8 }: RecentSessionsListProps) {
  const { t } = useTranslation('common');
  const { data, refetch } = useApi<RecentSession[]>(`/coder/sessions/recent?limit=${limit}`);

  useEffect(() => {
    const handler = () => refetch();
    window.addEventListener('coder:sessions-changed', handler);
    return () => window.removeEventListener('coder:sessions-changed', handler);
  }, [refetch]);

  if (!data || data.length === 0) return null;

  return (
    <div className="pt-2">
      <div className="px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
        <MessageSquareCode className="h-3 w-3" />
        {t('recent')}
      </div>
      <div className="space-y-0.5">
        {data.map((s) => {
          const active = s.id === activeSessionId;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.project_id, s.project_name, s.id)}
              title={`${s.title} — ${s.project_name}`}
              className={cn(
                'w-full flex items-start gap-2 px-3 py-1.5 rounded-lg text-left transition-colors',
                active
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <div
                className={cn(
                  'h-5 w-5 rounded flex items-center justify-center text-white text-[9px] font-bold uppercase shrink-0 mt-0.5',
                  providerAccent(s.provider),
                )}
              >
                {s.provider.slice(0, 2)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{s.title}</div>
                <div className="text-[10px] truncate opacity-70">
                  {s.project_name} · {formatRelativeTime(s.updated_at)}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
