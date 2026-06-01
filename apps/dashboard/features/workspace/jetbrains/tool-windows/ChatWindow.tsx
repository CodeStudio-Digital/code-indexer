/**
 * Chat tool window — sessions list first, chat after selection.
 *
 * The user feedback was that AgentChat's internal sidebar +
 * "start a conversation" empty state looked stuck side-by-side
 * inside the narrow right rail. New flow:
 *
 *   - Default view: a compact sessions list (search · filter active/
 *     archived · New session). Identical to the dedicated Sessions
 *     window we had before, so the Sessions activity icon goes away
 *     (one less duplicate surface).
 *   - Click a session: load it in AgentChat with a "← Sessions" back
 *     button in the header.
 *   - Active session id persists at the ChatWindow level — clicking
 *     Back doesn't lose your place if you open it again.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArchiveRestore,
  ArrowLeft,
  ChevronRight,
  Inbox,
  Loader2,
  MessageSquare,
  Plus,
  Search,
} from 'lucide-react';
import AgentChat from '../../../chat/index.js';
import { apiCall, apiBaseUrl } from '../../../../lib/api-client.js';
import { ToolWindowFrame } from '../ToolWindowFrame.js';
import { Button } from '../../../../components/ui/button.js';
import { Input } from '../../../../components/ui/input.js';
import { Tabs, TabsList, TabsTrigger } from '../../../../components/ui/tabs.js';
import { cn } from '../../../../lib/utils.js';
import { useApi, apiPost } from '../../../../hooks/useApi.js';
import { toast } from '../../../../components/ui/prompt-dialog.js';

interface ChatWindowProps {
  projectId: number;
  projectName: string;
  initialSessionId?: number;
  onClose?: () => void;
}

interface CoderSessionRow {
  id: number;
  title: string;
  provider: string;
  model: string;
  total_input_tokens: number;
  total_output_tokens: number;
  updated_at: string;
  is_favorite: boolean;
  is_archived: boolean;
}

type Filter = 'active' | 'archived';

export function ChatWindow({ projectId, projectName, initialSessionId, onClose }: ChatWindowProps) {
  const { t } = useTranslation('workspace');
  const [activeSessionId, setActiveSessionId] = useState<number | undefined>(initialSessionId);

  if (activeSessionId == null) {
    return (
      <ToolWindowFrame title={t('chat.title')} onClose={onClose}>
        <SessionsView
          projectId={projectId}
          projectName={projectName}
          onPickSession={(id) => setActiveSessionId(id)}
        />
      </ToolWindowFrame>
    );
  }

  return (
    <div className="h-full flex flex-col bg-card/20 min-h-0">
      <header className="h-7 shrink-0 border-b bg-card/40 flex items-center px-1.5 gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 text-muted-foreground hover:text-foreground"
          onClick={() => setActiveSessionId(undefined)}
          aria-label={t('chat.backToList')}
          title={t('chat.backToSessions')}
        >
          <ArrowLeft className="h-3 w-3" />
        </Button>
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] flex-1 truncate">
          {t('chat.sessionTitle', { id: activeSessionId })}
        </span>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-muted-foreground hover:text-foreground"
            onClick={onClose}
            aria-label={t('chat.closePanel')}
          >
            <ChevronRight className="h-3 w-3" />
          </Button>
        )}
      </header>
      <div className="flex-1 min-h-0 overflow-hidden">
        <AgentChat
          projectId={projectId}
          projectName={projectName}
          initialSessionId={activeSessionId}
        />
      </div>
    </div>
  );
}

// ─── Sessions list view ─────────────────────────────────────

interface SessionsViewProps {
  projectId: number;
  projectName: string;
  onPickSession: (id: number) => void;
}

function SessionsView({ projectId, projectName, onPickSession }: SessionsViewProps) {
  const { t } = useTranslation('workspace');
  const [filter, setFilter] = useState<Filter>('active');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const archivedQuery = filter === 'archived' ? '1' : '0';

  const { data, loading, error, refetch } = useApi<CoderSessionRow[]>(
    `/coder/sessions?project_id=${projectId}&archived=${archivedQuery}`,
  );

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return data;
    return data.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.provider.toLowerCase().includes(q) ||
        s.model.toLowerCase().includes(q),
    );
  }, [data, search]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      // Provider/model picking lives inside AgentChat once the session is
      // open — here we just spin one up with the project's defaults.
      const created = await apiPost<{ id: number; title: string }>('/coder/sessions', {
        project_id: projectId,
        title: 'Nova sessão',
        // Empty provider/model — the backend resolves the default pin and
        // AgentChat surfaces a picker on first send if neither matches a
        // configured key.
        provider: 'anthropic',
        model: '',
      });
      onPickSession(created.id);
    } catch (err) {
      toast.error(t('chat.createFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCreating(false);
    }
  }, [projectId, onPickSession]);

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 px-2.5 py-2 border-b space-y-2 bg-card/40">
        <div className="flex items-center gap-1.5">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} className="flex-1">
            <TabsList className="h-6 p-0.5 bg-muted/40">
              <TabsTrigger value="active" className="text-[10.5px] px-2 h-5">
                {t('chat.tabs.active')}
              </TabsTrigger>
              <TabsTrigger value="archived" className="text-[10.5px] px-2 h-5">
                <ArchiveRestore className="h-2.5 w-2.5 mr-1" />
                {t('chat.tabs.archived')}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            size="sm"
            className="h-6 text-[10.5px] px-2 gap-1"
            onClick={() => void handleCreate()}
            disabled={creating}
          >
            {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            {t('chat.new')}
          </Button>
        </div>
        <div className="relative">
          <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('chat.filterPlaceholder')}
            className="h-6 text-[11px] pl-7"
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && (
          <div className="px-3 py-3 text-[11px] text-muted-foreground">{t('chat.loading')}</div>
        )}
        {error && (
          <div className="px-3 py-3 text-[11px] text-destructive">{error}</div>
        )}
        {!loading && filtered.length === 0 && (
          <EmptySessions
            projectName={projectName}
            filter={filter}
            hasQuery={search.length > 0}
            onCreate={() => void handleCreate()}
            creating={creating}
          />
        )}
        {filtered.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onPickSession(s.id)}
            className={cn(
              'group w-full text-left px-2.5 py-1.5 border-b last:border-b-0',
              'hover:bg-muted/40 transition-colors flex flex-col gap-0.5',
            )}
            title={`${s.provider} / ${s.model || t('chat.defaultModel')}`}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground/70" />
              <span className="text-[11.5px] font-medium truncate flex-1">{s.title}</span>
              {s.is_favorite && <span className="text-amber-400 text-[10px]">★</span>}
            </div>
            <div className="text-[10px] text-muted-foreground flex items-center gap-1.5">
              <span className="font-mono truncate">{s.model || s.provider}</span>
              <span className="opacity-40">·</span>
              <span>{t('chat.tokensShort', { count: (s.total_input_tokens + s.total_output_tokens).toLocaleString() })}</span>
              <span className="opacity-40">·</span>
              <span title={s.updated_at}>{relativeTime(s.updated_at)}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

interface EmptySessionsProps {
  projectName: string;
  filter: Filter;
  hasQuery: boolean;
  onCreate: () => void;
  creating: boolean;
}

function EmptySessions({ projectName, filter, hasQuery, onCreate, creating }: EmptySessionsProps) {
  const { t } = useTranslation('workspace');
  if (hasQuery) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
        {t('chat.empty.filtered')}
      </div>
    );
  }
  if (filter === 'archived') {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-muted-foreground gap-2 grid place-items-center">
        <ArchiveRestore className="h-4 w-4 opacity-50" />
        <span>{t('chat.empty.archived')}</span>
      </div>
    );
  }
  return (
    <div className="px-3 py-6 grid place-items-center text-center gap-2.5">
      <div className="h-9 w-9 rounded-lg bg-primary/10 grid place-items-center">
        <Inbox className="h-4 w-4 text-primary/70" />
      </div>
      <div>
        <p className="text-[12px] font-medium text-foreground">{t('chat.empty.activeTitle')}</p>
        <p className="text-[10.5px] text-muted-foreground mt-0.5">
          {t('chat.empty.activeDescription', { projectName })}
        </p>
      </div>
      <Button
        size="sm"
        className="h-7 text-[11px] px-3 gap-1 mt-1"
        onClick={onCreate}
        disabled={creating}
      >
        {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
        {t('chat.empty.newSession')}
      </Button>
    </div>
  );
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const delta = Date.now() - t;
  const sec = Math.round(delta / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h`;
  const day = Math.round(hr / 24);
  return `${day}d`;
}

// Re-export apiBaseUrl so the import stays used (silences TS unused warning
// in builds where AgentChat ends up tree-shaken in production).
void apiBaseUrl;
