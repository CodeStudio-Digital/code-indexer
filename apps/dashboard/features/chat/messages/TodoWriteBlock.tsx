import { Check, Circle, Loader2 } from 'lucide-react';
import { cn } from '../../../lib/utils.js';

/**
 * Rich checklist render for the `todo_write` / `update_todo` tool calls in the
 * chat transcript — replaces the raw JSON dump. Both tools emit the same
 * result text (`formatSummary` + `formatTodoLine` in tools/todo.ts):
 *
 *   4 todos: 0 completed, 1 in_progress, 3 pending
 *     [~] (id=85fc6477) Lendo estado atual…
 *     [ ] (id=ca61e551) Aplicar tema…
 *     [x] (id=…) …
 *
 * Marker → status: `[x]` completed, `[~]` in_progress, `[ ]` pending.
 * Parsing the result text (not the input) works uniformly for both tools —
 * `update_todo` only carries a single-item patch in its input but the result
 * always reflects the full reconciled list.
 */
type TodoStatus = 'completed' | 'in_progress' | 'pending';
interface ParsedTodo {
  status: TodoStatus;
  id: string;
  label: string;
}

const LINE_RE = /^\s*\[([ x~])\]\s*\(id=([^)]+)\)\s*(.*)$/;

function parseTodos(text: string): { summary: string; todos: ParsedTodo[] } {
  const todos: ParsedTodo[] = [];
  let summary = '';
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line);
    if (m) {
      const status: TodoStatus = m[1] === 'x' ? 'completed' : m[1] === '~' ? 'in_progress' : 'pending';
      todos.push({ status, id: m[2], label: m[3].trim() });
    } else if (!summary && /\btodos?\b/i.test(line)) {
      summary = line.trim();
    }
  }
  return { summary, todos };
}

export function TodoWriteBlock({ text }: { text: string }) {
  const { summary, todos } = parseTodos(text);
  if (todos.length === 0) {
    // "Todo list cleared." or an unparseable/error result — show the raw text.
    return <div className="text-xs text-muted-foreground whitespace-pre-wrap">{text || 'Todo list cleared.'}</div>;
  }
  return (
    <div className="space-y-1.5">
      {summary && <div className="text-[11px] font-medium text-muted-foreground">{summary}</div>}
      <ul className="space-y-1">
        {todos.map((t) => (
          <li key={t.id} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5 shrink-0">
              {t.status === 'completed' ? (
                <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              ) : t.status === 'in_progress' ? (
                <Loader2 className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
              ) : (
                <Circle className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </span>
            <span
              className={cn(
                'flex-1',
                t.status === 'completed' && 'text-muted-foreground line-through',
                t.status === 'in_progress' && 'text-foreground font-medium',
                t.status === 'pending' && 'text-foreground/80',
              )}
            >
              {t.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
