import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Bot, Crown, MessageSquare, KanbanSquare, Loader2 } from 'lucide-react';
import { useApi } from '../../hooks/useApi.js';
import { formatDateTime } from '../../lib/datetime.js';
import { ArchiveDetailModal } from './ArchiveDetailModal.js';

interface ArchiveSummary {
  id: number;
  company_session_id: number;
  archived_at: string;
  reason: string | null;
  included_kanban: boolean;
  included_sandbox: boolean;
  stats: {
    agent_runs: number;
    board_entries: number;
    master_prompts: number;
    kanban_cards: number;
  };
}

interface ArchivedTabProps {
  companySessionId: number;
}

/**
 * Lista de arquivos da sessão. Cada entry mostra contagens agregadas
 * (agents/mensagens/cards) e abre um modal com o detalhe completo ao
 * clicar. A data é exibida em formato local (não relativo — o usuário
 * deixou claro no plano que quer cronológico explícito).
 */
export function ArchivedTab({ companySessionId }: ArchivedTabProps) {
  const { t } = useTranslation('agents');
  const { data: archives, loading, refetch } = useApi<ArchiveSummary[]>(
    `/company/sessions/${companySessionId}/archives`,
  );
  const [selectedArchiveId, setSelectedArchiveId] = useState<number | null>(null);

  return (
    <div className="h-full overflow-y-auto p-4 space-y-2">
      {loading && (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          {t('archived.loading')}
        </div>
      )}

      {!loading && (!archives || archives.length === 0) && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Archive className="h-8 w-8 text-muted-foreground/50 mb-2" />
          <p className="text-sm text-muted-foreground">{t('archived.empty')}</p>
          <p className="text-xs text-muted-foreground/70 mt-1 max-w-sm">
            {t('archived.emptyHint')}
          </p>
        </div>
      )}

      {archives?.map((a) => (
        <button
          key={a.id}
          onClick={() => setSelectedArchiveId(a.id)}
          className="w-full text-left rounded-md border bg-card hover:bg-muted/50 transition-colors px-3 py-2.5"
        >
          <div className="flex items-center gap-2 flex-wrap">
            <Archive className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-sm font-medium">
              {formatDateTime(a.archived_at)}
            </span>
            <span className="text-[10px] text-muted-foreground ml-auto">#{a.id}</span>
          </div>
          {a.reason && (
            <p className="text-xs text-muted-foreground mt-1 italic line-clamp-2">
              "{a.reason}"
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Bot className="h-3 w-3" /> {a.stats.agent_runs} agents
            </span>
            <span className="flex items-center gap-1">
              <MessageSquare className="h-3 w-3" /> {t('archived.messages', { count: a.stats.board_entries })}
            </span>
            {a.included_kanban && (
              <span className="flex items-center gap-1">
                <KanbanSquare className="h-3 w-3" /> {a.stats.kanban_cards} cards
              </span>
            )}
            {a.included_sandbox && (
              <span className="text-amber-600">{t('archived.sandboxDestroyed')}</span>
            )}
          </div>
        </button>
      ))}

      {selectedArchiveId !== null && (
        <ArchiveDetailModal
          companySessionId={companySessionId}
          archiveId={selectedArchiveId}
          onClose={() => setSelectedArchiveId(null)}
        />
      )}
    </div>
  );
}
