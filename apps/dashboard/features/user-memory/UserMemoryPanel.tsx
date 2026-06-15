/**
 * Global user-memory panel (migration 145) — view/add/edit/delete the
 * cross-project "who I am / how I want you to work" facts the agent reads on
 * EVERY project. Backed by /api/user-memory (reserved user project, scope
 * 'user'). Surfaced under the project Memory tab because that's where users
 * look at what the agent has learned; the content itself is global.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserCog, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { apiPost, apiPut, apiDelete, useApi } from '../../hooks/useApi.js';
import { cn } from '../../lib/utils.js';
import { CATEGORY_COLORS } from '../snapshots/snapshot-types.js';

interface UserMem {
  id: number;
  title: string;
  content: string;
  category: string;
  importance: number;
}

const inputCls =
  'w-full rounded border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary';

export function UserMemoryPanel() {
  const { t } = useTranslation('projects');
  const { data, refetch } = useApi<UserMem[]>('/user-memory');
  const [draft, setDraft] = useState<{ title: string; content: string; category: string }>({
    title: '', content: '', category: 'feedback',
  });
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!draft.title.trim() || !draft.content.trim()) return;
    setBusy(true);
    try {
      await apiPost('/user-memory', draft);
      setDraft({ title: '', content: '', category: 'feedback' });
      refetch();
    } finally {
      setBusy(false);
    }
  };

  const saveContent = async (m: UserMem, content: string) => {
    if (content === m.content) return;
    await apiPut(`/user-memory/${m.id}`, { content });
    refetch();
  };

  const remove = async (id: number) => {
    await apiDelete(`/user-memory/${id}`);
    refetch();
  };

  const rows = data ?? [];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <UserCog className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-medium">{t('userMemory.title')}</h3>
        <span className="text-[10px] text-muted-foreground">{t('userMemory.subtitle')}</span>
      </div>

      <div className="flex flex-wrap items-start gap-2 rounded border bg-muted/30 p-2">
        <input
          className={cn(inputCls, 'flex-1 min-w-[140px]')}
          placeholder={t('userMemory.titlePlaceholder')}
          value={draft.title}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
        />
        <select
          className={cn(inputCls, 'w-28')}
          value={draft.category}
          onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
        >
          <option value="feedback">{t('userMemory.cat.feedback')}</option>
          <option value="user">{t('userMemory.cat.user')}</option>
        </select>
        <input
          className={cn(inputCls, 'flex-[2] min-w-[200px]')}
          placeholder={t('userMemory.contentPlaceholder')}
          value={draft.content}
          onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
          onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
        />
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void add()}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground px-1">{t('userMemory.empty')}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((m) => (
            <li key={m.id} className="flex items-start gap-2 rounded border px-2 py-1.5">
              <span
                className={cn(
                  'mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium capitalize',
                  CATEGORY_COLORS[m.category] ?? CATEGORY_COLORS.note,
                )}
              >
                {m.category}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium truncate">{m.title}</div>
                <textarea
                  className={cn(inputCls, 'mt-1 resize-y')}
                  rows={2}
                  defaultValue={m.content}
                  onBlur={(e) => void saveContent(m, e.target.value)}
                />
              </div>
              <button
                type="button"
                aria-label={t('userMemory.delete')}
                onClick={() => void remove(m.id)}
                className="mt-0.5 p-1 rounded text-muted-foreground hover:bg-muted hover:text-red-500"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
