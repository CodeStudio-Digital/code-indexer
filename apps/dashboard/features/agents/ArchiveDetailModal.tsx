import React, { useState } from 'react';
import { Archive, Bot, Crown, KanbanSquare, MessageSquare, X, Loader2 } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { useApi } from '../../hooks/useApi.js';
import { AgentSessionModal } from './AgentSessionModal.js';

interface ArchivedAgentRun {
  id: number;
  role: string;
  provider: string;
  model: string;
  status: string;
  coder_session_id: number;
  created_at: string;
  updated_at: string;
  status_message: string | null;
}

interface ArchivedBoardEntry {
  id: number;
  author_role: string;
  kind: string;
  content: string;
  created_at: string;
}

interface ArchivedKanbanCard {
  id: number;
  title: string;
  description: string;
  column: string;
  tag: string | null;
}

interface ArchiveDetail {
  archive: {
    id: number;
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
  };
  agent_runs: ArchivedAgentRun[];
  board: ArchivedBoardEntry[];
  kanban: ArchivedKanbanCard[];
}

interface ArchiveDetailModalProps {
  companySessionId: number;
  archiveId: number;
  onClose: () => void;
}

type View = 'board' | 'kanban';

/**
 * Read-only snapshot of an archived company session state. Left column
 * lists the agents that ran; clicking one opens the existing
 * AgentSessionModal with the coder_session's full message history.
 * Right side flips between Board and Kanban snapshots.
 */
export function ArchiveDetailModal({
  companySessionId,
  archiveId,
  onClose,
}: ArchiveDetailModalProps) {
  const { data, loading } = useApi<ArchiveDetail>(
    `/company/sessions/${companySessionId}/archives/${archiveId}`,
  );
  const [view, setView] = useState<View>('board');
  const [openAgent, setOpenAgent] = useState<ArchivedAgentRun | null>(null);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-card rounded-lg border shadow-xl w-full max-w-5xl h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <Archive className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">Arquivo #{archiveId}</span>
          {data && (
            <span className="text-xs text-muted-foreground">
              {new Date(data.archive.archived_at + 'Z').toLocaleString()}
            </span>
          )}
          <Badge variant="outline" className="text-[10px]">read-only</Badge>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0 ml-auto">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {loading && (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Carregando arquivo…
          </div>
        )}

        {data && (
          <>
            {data.archive.reason && (
              <div className="px-4 py-2 border-b bg-muted/30 text-xs italic">
                "{data.archive.reason}"
              </div>
            )}

            <div className="flex-1 flex overflow-hidden">
              {/* Left — Agents */}
              <div className="w-64 border-r overflow-y-auto p-2 space-y-1 shrink-0">
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Agentes ({data.agent_runs.length})
                </div>
                {data.agent_runs.map((run) => (
                  <button
                    key={run.id}
                    onClick={() => setOpenAgent(run)}
                    className="w-full text-left rounded-md border bg-background hover:bg-muted transition-colors px-2 py-1.5"
                  >
                    <div className="flex items-center gap-1.5">
                      {run.role === 'master' ? (
                        <Crown className="h-3 w-3 text-yellow-400 shrink-0" />
                      ) : (
                        <Bot className="h-3 w-3 text-muted-foreground shrink-0" />
                      )}
                      <span className="text-xs font-medium truncate">{run.role}</span>
                      <Badge variant="outline" className="text-[9px] ml-auto capitalize">
                        {run.status}
                      </Badge>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5 font-mono truncate">
                      {run.provider}/{run.model}
                    </div>
                  </button>
                ))}
                {data.agent_runs.length === 0 && (
                  <p className="px-2 py-4 text-xs text-muted-foreground text-center">
                    Sem agentes.
                  </p>
                )}
              </div>

              {/* Right — Board / Kanban */}
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex border-b">
                  <button
                    onClick={() => setView('board')}
                    className={
                      'px-3 py-1.5 text-xs flex items-center gap-1 border-b-2 transition-colors ' +
                      (view === 'board'
                        ? 'border-primary text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground')
                    }
                  >
                    <MessageSquare className="h-3 w-3" />
                    Board ({data.board.length})
                  </button>
                  {data.archive.included_kanban && (
                    <button
                      onClick={() => setView('kanban')}
                      className={
                        'px-3 py-1.5 text-xs flex items-center gap-1 border-b-2 transition-colors ' +
                        (view === 'kanban'
                          ? 'border-primary text-foreground'
                          : 'border-transparent text-muted-foreground hover:text-foreground')
                      }
                    >
                      <KanbanSquare className="h-3 w-3" />
                      Kanban ({data.kanban.length})
                    </button>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto p-3">
                  {view === 'board' && (
                    <div className="space-y-2">
                      {data.board.map((b) => (
                        <div key={b.id} className="rounded-md border bg-card p-2">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant="outline" className="text-[9px] capitalize">
                              @{b.author_role}
                            </Badge>
                            <Badge variant="outline" className="text-[9px] capitalize">
                              {b.kind}
                            </Badge>
                            <span className="text-[10px] text-muted-foreground ml-auto">
                              {new Date(b.created_at + 'Z').toLocaleString()}
                            </span>
                          </div>
                          <div className="text-xs whitespace-pre-wrap break-words">
                            {b.content}
                          </div>
                        </div>
                      ))}
                      {data.board.length === 0 && (
                        <p className="text-center text-xs text-muted-foreground py-8">
                          Board vazio nesse snapshot.
                        </p>
                      )}
                    </div>
                  )}

                  {view === 'kanban' && data.archive.included_kanban && (
                    <div className="space-y-2">
                      {data.kanban.map((card) => (
                        <div key={card.id} className="rounded-md border bg-card p-2">
                          <div className="flex items-center gap-2 mb-0.5">
                            <Badge variant="outline" className="text-[9px] capitalize">
                              {card.column.replace('_', ' ')}
                            </Badge>
                            {card.tag && (
                              <Badge variant="outline" className="text-[9px]">{card.tag}</Badge>
                            )}
                          </div>
                          <div className="text-xs font-medium">{card.title}</div>
                          {card.description && (
                            <div className="text-[11px] text-muted-foreground whitespace-pre-wrap mt-0.5">
                              {card.description}
                            </div>
                          )}
                        </div>
                      ))}
                      {data.kanban.length === 0 && (
                        <p className="text-center text-xs text-muted-foreground py-8">
                          Nenhum card arquivado.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Nested: click an agent to see its full coder_session messages */}
      {openAgent && (
        <AgentSessionModal
          coderSessionId={openAgent.coder_session_id}
          role={openAgent.role}
          status={openAgent.status}
          onClose={() => setOpenAgent(null)}
        />
      )}
    </div>
  );
}
