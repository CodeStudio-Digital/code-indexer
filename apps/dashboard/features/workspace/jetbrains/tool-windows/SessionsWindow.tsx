/**
 * Sessions tool window — compact list of coder sessions for this project.
 * Click a row to load it in the Chat tool window (the right rail auto-
 * switches to Chat). Today's chip set: title + provider/model + tokens.
 */

import { useEffect } from 'react';
import { Inbox, MessageSquare } from 'lucide-react';
import { useApi } from '../../../../hooks/useApi.js';
import { ToolWindowFrame } from '../ToolWindowFrame.js';
import { useWorkspaceLayout } from '../../../../state/workspace-layout.js';
import { cn } from '../../../../lib/utils.js';

interface SessionRow {
  id: number;
  title: string;
  provider: string;
  model: string;
  total_input_tokens: number;
  total_output_tokens: number;
  updated_at: string;
  is_favorite: boolean;
}

interface SessionsWindowProps {
  projectId: number;
  activeSessionId?: number;
  onSelectSession: (sessionId: number) => void;
  onClose?: () => void;
}

export function SessionsWindow({
  projectId,
  activeSessionId,
  onSelectSession,
  onClose,
}: SessionsWindowProps) {
  const setActiveRight = useWorkspaceLayout((s) => s.setActiveRight);
  const { data, refetch } = useApi<SessionRow[]>(`/coder/sessions?project_id=${projectId}&archived=0`);

  // Refetch when the window opens so the list is fresh after creating
  // new sessions via the chat composer.
  useEffect(() => {
    refetch();
  }, [refetch]);

  return (
    <ToolWindowFrame title="Sessions" onClose={onClose}>
      <div className="h-full flex flex-col min-h-0">
        <div className="flex-1 min-h-0 overflow-y-auto">
          {(!data || data.length === 0) && (
            <div className="px-3 py-6 grid place-items-center text-center text-muted-foreground gap-2">
              <Inbox className="h-5 w-5 opacity-50" />
              <p className="text-[11px]">No sessions yet for this project.</p>
              <button
                type="button"
                onClick={() => setActiveRight('chat')}
                className="text-[11px] text-primary hover:underline"
              >
                Open chat to start one
              </button>
            </div>
          )}
          {data?.map((s) => {
            const active = s.id === activeSessionId;
            const total = s.total_input_tokens + s.total_output_tokens;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  onSelectSession(s.id);
                  setActiveRight('chat');
                }}
                className={cn(
                  'group w-full text-left px-2.5 py-1.5 border-b last:border-b-0',
                  'hover:bg-muted/40 transition-colors flex flex-col gap-0.5',
                  active && 'bg-primary/5',
                )}
                title={`${s.provider} / ${s.model}`}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <MessageSquare
                    className={cn(
                      'h-3 w-3 shrink-0',
                      active ? 'text-primary' : 'text-muted-foreground/70',
                    )}
                  />
                  <span className="text-[11.5px] font-medium truncate flex-1">{s.title}</span>
                  {s.is_favorite && <span className="text-amber-400 text-[10px]">★</span>}
                </div>
                <div className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                  <span className="font-mono">{s.model || s.provider}</span>
                  <span className="opacity-40">·</span>
                  <span>{total.toLocaleString()} tok</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </ToolWindowFrame>
  );
}
