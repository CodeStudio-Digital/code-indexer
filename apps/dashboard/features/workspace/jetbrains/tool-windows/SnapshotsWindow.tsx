/**
 * Snapshots tool window — curated project notes (decisions, requirements,
 * context summaries). Replaces the Day-6 placeholder.
 *
 * UX: list grouped by category in the panel; selecting a snapshot opens
 * a modal with edit/delete actions + a "New snapshot" button at the top.
 * Read-only quick preview in the list (first line of content).
 *
 * Backed by `snapshots.*` handlers (list/create/update/delete). The
 * underlying SnapshotService writes embeddings too, but that's
 * orthogonal to the UI — embed_error surfaces in the modal if it fails.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { apiCall } from '../../../../lib/api-client.js';
import { Button } from '../../../../components/ui/button.js';
import { Input } from '../../../../components/ui/input.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../components/ui/dialog.js';
import { ToolWindowFrame } from '../ToolWindowFrame.js';
import { cn } from '../../../../lib/utils.js';

interface Snapshot {
  id: number;
  project_id: number;
  title: string;
  category: string;
  content: string;
  tags?: string[] | string;
  created_at: string;
  updated_at: string;
}

interface SnapshotsWindowProps {
  projectId: number;
  onClose?: () => void;
}

const CATEGORY_ORDER = ['decision', 'requirement', 'context', 'note', 'pattern'];

function groupByCategory(items: Snapshot[]): Record<string, Snapshot[]> {
  const out: Record<string, Snapshot[]> = {};
  for (const s of items) {
    const k = s.category || 'other';
    (out[k] ??= []).push(s);
  }
  return out;
}

export function SnapshotsWindow({ projectId, onClose }: SnapshotsWindowProps) {
  const [items, setItems] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Snapshot | 'new' | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await apiCall<Snapshot[]>('snapshots.list', { projectId });
      setItems(list ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const grouped = useMemo(() => groupByCategory(items ?? []), [items]);
  const categories = useMemo(
    () =>
      Object.keys(grouped).sort((a, b) => {
        const ai = CATEGORY_ORDER.indexOf(a);
        const bi = CATEGORY_ORDER.indexOf(b);
        if (ai < 0 && bi < 0) return a.localeCompare(b);
        if (ai < 0) return 1;
        if (bi < 0) return -1;
        return ai - bi;
      }),
    [grouped],
  );

  return (
    <>
      <ToolWindowFrame
        title="Snapshots"
        onClose={onClose}
        actions={
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-muted-foreground hover:text-foreground"
            onClick={() => setEditing('new')}
            aria-label="New snapshot"
          >
            <Plus className="h-3 w-3" />
          </Button>
        }
      >
        <div className="h-full overflow-y-auto">
          {items === null && (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">Loading…</div>
          )}
          {error && <div className="px-3 py-2 text-[11px] text-destructive">{error}</div>}
          {items?.length === 0 && (
            <div className="px-3 py-6 text-center text-[11px] text-muted-foreground space-y-2">
              <p>No snapshots yet.</p>
              <button
                type="button"
                onClick={() => setEditing('new')}
                className="text-primary hover:underline"
              >
                Create the first one
              </button>
            </div>
          )}
          {categories.map((cat) => (
            <div key={cat}>
              <div className="px-2.5 pt-2 pb-1 text-[10px] uppercase tracking-[0.08em] text-muted-foreground/70 font-semibold">
                {cat}
              </div>
              {grouped[cat].map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setEditing(s)}
                  className={cn(
                    'w-full text-left px-2.5 py-1.5 border-b last:border-b-0',
                    'hover:bg-muted/40 transition-colors flex flex-col gap-0.5',
                  )}
                >
                  <span className="text-[11.5px] text-foreground font-medium truncate">
                    {s.title}
                  </span>
                  <span className="text-[10.5px] text-muted-foreground truncate">
                    {s.content.split('\n')[0]}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </ToolWindowFrame>
      {editing !== null && (
        <SnapshotEditorDialog
          projectId={projectId}
          snapshot={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
          onDeleted={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

interface SnapshotEditorDialogProps {
  projectId: number;
  snapshot: Snapshot | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}

function SnapshotEditorDialog({
  projectId,
  snapshot,
  onClose,
  onSaved,
  onDeleted,
}: SnapshotEditorDialogProps) {
  const [title, setTitle] = useState(snapshot?.title ?? '');
  const [category, setCategory] = useState(snapshot?.category ?? 'note');
  const [content, setContent] = useState(snapshot?.content ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      if (snapshot) {
        await apiCall<{ ok: true }>('snapshots.update', {
          id: snapshot.id,
          title,
          category,
          content,
        });
      } else {
        await apiCall<{ id: number }>('snapshots.create', {
          projectId,
          title,
          category,
          content,
        });
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!snapshot) return;
    if (!window.confirm(`Delete snapshot "${snapshot.title}"?`)) return;
    setSaving(true);
    try {
      await apiCall<{ ok: true }>('snapshots.delete', { id: snapshot.id });
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {snapshot ? 'Edit snapshot' : 'New snapshot'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_140px] gap-2">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title"
              className="h-8 text-[13px]"
            />
            <Input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Category"
              className="h-8 text-[13px]"
            />
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Content (markdown OK)…"
            className={cn(
              'w-full min-h-[220px] rounded-md border bg-card px-3 py-2 text-[12.5px] font-mono',
              'focus:outline-none focus:ring-2 focus:ring-ring/40',
            )}
          />
          {err && <div className="text-[11px] text-destructive">{err}</div>}
        </div>
        <DialogFooter className="gap-2">
          {snapshot && (
            <Button
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 mr-auto"
              onClick={() => void remove()}
              disabled={saving}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || !title.trim()}>
            {saving ? 'Saving…' : snapshot ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
