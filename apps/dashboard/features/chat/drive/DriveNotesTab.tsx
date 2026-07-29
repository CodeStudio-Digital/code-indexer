/**
 * Notes tab — the session's working notes (written by the agent's `save_note`
 * tool, re-injected after compaction). Compact list: a click opens the note
 * in a modal rendered as markdown, where you can edit / pin / delete.
 * Session-scoped — distinct from project-wide memory (`mcp__save_memory`).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Pin, PinOff, Plus, Trash2 } from 'lucide-react';
import { apiPost, apiPatch, apiDelete } from '../../../hooks/useApi.js';
import { Button } from '../../../components/ui/button.js';
import { confirm } from '../../../components/ui/prompt-dialog.js';
import { Markdown } from '../messages/Markdown.js';
import { DriveDetailDialog } from './DriveDetailDialog.js';
import type { DriveMemory } from './types.js';

function preview(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 100);
}

export function DriveNotesTab({
  sessionId,
  memory,
  onChanged,
}: {
  sessionId: string;
  memory: DriveMemory[];
  onChanged: () => void;
}) {
  const { t } = useTranslation('chat');
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<DriveMemory | null>(null);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState('');

  const base = `/coder/sessions/${sessionId}/drive/memory`;

  const add = async () => {
    if (!title.trim() || !body.trim()) return;
    setBusy(true);
    try {
      await apiPost(base, { title: title.trim(), body: body.trim() });
      setTitle('');
      setBody('');
      setAdding(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const togglePin = async (m: DriveMemory) => {
    await apiPatch(`${base}/${m.id}`, { pinned: !m.pinned });
    if (selected?.id === m.id) setSelected({ ...m, pinned: !m.pinned });
    onChanged();
  };

  const remove = async (m: DriveMemory) => {
    if (!(await confirm({
      title: t('drive.deleteConfirm', { name: m.title }),
      description: t('drive.deleteConfirmBody'),
      confirmLabel: t('drive.delete'),
      tone: 'destructive',
    }))) return;
    await apiDelete(`${base}/${m.id}`);
    if (selected?.id === m.id) setSelected(null);
    onChanged();
  };

  const saveEdit = async () => {
    if (!selected || !editBody.trim()) return;
    setBusy(true);
    try {
      await apiPost(base, { title: selected.title, body: editBody.trim(), kind: selected.kind });
      setSelected({ ...selected, body: editBody.trim() });
      setEditing(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const open = (m: DriveMemory) => {
    setSelected(m);
    setEditing(false);
  };

  return (
    <div className="space-y-2">
      {adding ? (
        <div className="space-y-1.5 rounded border border-border/50 p-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('drive.noteTitle', 'Title (the key)')}
            className="w-full bg-background border rounded px-2 py-1 text-xs"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('drive.noteBody', 'What to remember…')}
            rows={3}
            className="w-full bg-background border rounded px-2 py-1 text-xs resize-y"
          />
          <div className="flex gap-1.5 justify-end">
            <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setAdding(false)} disabled={busy}>
              {t('drive.cancel', 'Cancel')}
            </Button>
            <Button size="sm" className="h-6 text-[11px]" onClick={add} disabled={busy || !title.trim() || !body.trim()}>
              {t('drive.save', 'Save')}
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="w-full h-7 text-[11px]" onClick={() => setAdding(true)}>
          <Plus className="h-3 w-3 mr-1" />
          {t('drive.addNote', 'Add note')}
        </Button>
      )}

      {memory.length === 0 ? (
        <div className="text-xs text-muted-foreground text-center py-6">{t('drive.memoryEmpty', 'No notes yet.')}</div>
      ) : (
        <ul className="space-y-1">
          {memory.map((m) => (
            <li
              key={m.id}
              role="button"
              tabIndex={0}
              onClick={() => open(m)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(m); } }}
              className="group block cursor-pointer rounded border border-border/40 bg-muted/20 px-2 py-1.5 hover:bg-muted/40 transition-colors"
            >
              <div className="flex items-center gap-1.5">
                {m.pinned ? <Pin className="h-3 w-3 text-primary shrink-0" /> : null}
                <span className="text-[11px] font-medium truncate flex-1">{m.title}</span>
                <span className="text-[9px] uppercase text-muted-foreground shrink-0">{m.kind}</span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); void togglePin(m); }}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground"
                  title={m.pinned ? t('drive.unpin', 'Unpin') : t('drive.pin', 'Pin')}
                >
                  {m.pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); void remove(m); }}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                  title={t('drive.delete', 'Delete')}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{preview(m.body)}</p>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <DriveDetailDialog
          open
          onOpenChange={(o) => { if (!o) { setSelected(null); setEditing(false); } }}
          title={selected.title}
          meta={`${selected.kind}${selected.pinned ? ' · 📌' : ''} · ${selected.updated_at}`}
          footer={
            editing ? (
              <>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing(false)} disabled={busy}>
                  {t('drive.cancel', 'Cancel')}
                </Button>
                <Button size="sm" className="h-7 text-xs" onClick={saveEdit} disabled={busy || !editBody.trim()}>
                  {t('drive.save', 'Save')}
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => remove(selected)}>
                  <Trash2 className="h-3 w-3 mr-1" />{t('drive.delete', 'Delete')}
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => togglePin(selected)}>
                  {selected.pinned ? <PinOff className="h-3 w-3 mr-1" /> : <Pin className="h-3 w-3 mr-1" />}
                  {selected.pinned ? t('drive.unpin', 'Unpin') : t('drive.pin', 'Pin')}
                </Button>
                <Button size="sm" className="h-7 text-xs" onClick={() => { setEditBody(selected.body); setEditing(true); }}>
                  <Pencil className="h-3 w-3 mr-1" />{t('drive.edit', 'Edit')}
                </Button>
              </>
            )
          }
        >
          {editing ? (
            <textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              rows={12}
              className="w-full bg-background border rounded px-2 py-1.5 text-xs font-mono resize-y"
            />
          ) : (
            <Markdown text={selected.body} />
          )}
        </DriveDetailDialog>
      ) : null}
    </div>
  );
}
