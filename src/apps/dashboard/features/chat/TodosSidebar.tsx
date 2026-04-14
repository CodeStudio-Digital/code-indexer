import { useTranslation } from 'react-i18next';
import { Check, Circle, Loader2 } from 'lucide-react';
import type { TodoItem } from '../../hooks/agent-stream/types.js';

/**
 * TodosSidebar — live checklist rendered next to the chat transcript.
 *
 * Distinct from the task-list / plan-approval modals:
 *   - Never pauses the run, never has buttons.
 *   - Reflects whatever the agent last pushed via the `todo_write` native tool.
 *   - Persists across reloads because the backend writes `todos_json` to
 *     `coder_sessions` on every `todos_updated` event (migration 013).
 *
 * Hidden when the list is empty so it doesn't take space in short sessions
 * that never called todo_write.
 */

interface TodosSidebarProps {
  todos: TodoItem[];
}

export function TodosSidebar({ todos }: TodosSidebarProps) {
  const { t } = useTranslation('chat');
  if (todos.length === 0) return null;

  const completed = todos.filter((td) => td.status === 'completed').length;
  const total = todos.length;
  const percent = Math.round((completed / total) * 100);

  return (
    <aside className="border-l bg-card/50 w-64 shrink-0 overflow-y-auto hidden lg:block">
      <div className="sticky top-0 bg-card border-b px-3 py-2.5">
        <div className="flex items-center justify-between text-xs font-medium">
          <span className="text-foreground">{t('todos.title')}</span>
          <span className="text-muted-foreground">
            {t('todos.progress', { completed, total, percent })}
          </span>
        </div>
        <div className="mt-1.5 h-1 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <ul className="px-2 py-2 space-y-1">
        {todos.map((t, i) => (
          <li
            key={`${i}-${t.content}`}
            className="flex items-start gap-2 text-xs px-1.5 py-1.5 rounded hover:bg-muted/50 transition-colors"
          >
            <span className="mt-0.5 shrink-0">
              {t.status === 'completed' ? (
                <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              ) : t.status === 'in_progress' ? (
                <Loader2 className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 animate-spin" />
              ) : (
                <Circle className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </span>
            <span
              className={
                t.status === 'completed'
                  ? 'text-muted-foreground line-through'
                  : t.status === 'in_progress'
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground'
              }
            >
              {t.status === 'in_progress' ? t.activeForm : t.content}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
