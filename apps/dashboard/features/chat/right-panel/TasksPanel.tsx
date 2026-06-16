/**
 * Tasks panel — dedicated right-rail tool window for the `todo_write` history.
 * Extracted from the old `details` panel's "Tarefas" tab so it gets its own
 * rail icon. Fetches `/coder/sessions/:id/todo-history` (gated on `active`).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, Circle, Loader2 } from 'lucide-react';
import { useApi } from '../../../hooks/useApi.js';
import { formatRelativeTime } from '../../../lib/utils.js';

interface TodoHistoryEntry {
  id: number;
  args_json: string;
  created_at: string;
}

interface TodoItem {
  content: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export function TasksPanel({ sessionId, active }: { sessionId: number | null; active: boolean }) {
  const { t } = useTranslation(['chat', 'common']);
  const url = active && sessionId ? `/coder/sessions/${sessionId}/todo-history` : '';
  const { data: history, loading } = useApi<TodoHistoryEntry[]>(url);
  return (
    <div className="flex-1 overflow-y-auto px-3 py-3">
      {loading && <div className="text-xs text-muted-foreground">{t('common:actions.loading')}</div>}
      {!loading && (!history || history.length === 0) && (
        <div className="text-xs text-muted-foreground py-8 text-center">{t('chat:details.noTasks')}</div>
      )}
      <div className="space-y-2">
        {history?.map((entry) => <TodoHistoryItem key={entry.id} entry={entry} />)}
      </div>
    </div>
  );
}

function TodoHistoryItem({ entry }: { entry: TodoHistoryEntry }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);

  let todos: TodoItem[] = [];
  try {
    const parsed = JSON.parse(entry.args_json);
    if (Array.isArray(parsed.todos)) todos = parsed.todos;
  } catch {
    /* invalid json — leave empty */
  }

  const completed = todos.filter((td) => td.status === 'completed').length;
  const total = todos.length;
  const preview =
    todos.find((td) => td.status === 'in_progress')?.activeForm ??
    todos.find((td) => td.status === 'pending')?.content ??
    todos[todos.length - 1]?.content ??
    '';

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              {t('details.tasksCompleted', { completed, total })}
            </span>
            <span className="text-[11px] text-muted-foreground">{formatRelativeTime(entry.created_at)}</span>
          </div>
          {!open && total > 0 && <div className="text-xs text-foreground/80 truncate">{preview}</div>}
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 border-t bg-muted/20">
          <ul className="pt-2 space-y-1">
            {todos.map((td, i) => (
              <li key={`${i}-${td.content}`} className="flex items-start gap-2 text-xs px-1.5 py-1">
                <span className="mt-0.5 shrink-0">
                  {td.status === 'completed' ? (
                    <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : td.status === 'in_progress' ? (
                    <Loader2 className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 animate-spin" />
                  ) : (
                    <Circle className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </span>
                <span
                  className={
                    td.status === 'completed'
                      ? 'text-muted-foreground line-through'
                      : td.status === 'in_progress'
                        ? 'text-foreground font-medium'
                        : 'text-muted-foreground'
                  }
                >
                  {td.status === 'in_progress' ? td.activeForm : td.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
