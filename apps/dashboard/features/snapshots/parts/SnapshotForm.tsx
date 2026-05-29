/**
 * Modal form for creating or editing a context snapshot. Used by
 * `SnapshotEditor` from both the sidebar "+ New" button and the detail
 * pane "Edit" action. When `snapshot` is supplied, the form mounts with
 * its fields pre-filled and submits via PUT; without it, POST creates a
 * fresh row.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.js';
import { Input } from '../../../components/ui/input.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { apiPost } from '../../../hooks/useApi.js';
import { CATEGORIES, parseTags, type Snapshot } from '../snapshot-types.js';

interface SnapshotFormProps {
  projectId: number;
  /** When set, the form is in "edit" mode — pre-fills + uses PUT. */
  snapshot: Snapshot | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function SnapshotForm({
  projectId,
  snapshot,
  open,
  onOpenChange,
  onSaved,
}: SnapshotFormProps) {
  const { t } = useTranslation(['projects', 'common']);
  const isEdit = snapshot != null;

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<string>('note');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Repopulate fields when the dialog re-opens for a different snapshot
  // (the same form instance is reused across the session, so we can't
  // rely on mount-time defaults).
  useEffect(() => {
    if (!open) return;
    if (snapshot) {
      setTitle(snapshot.title);
      setCategory(snapshot.category);
      setContent(snapshot.content);
      setTags(parseTags(snapshot.tags).filter((x) => x !== 'auto-generated').join(', '));
    } else {
      setTitle('');
      setCategory('note');
      setContent('');
      setTags('');
    }
    setError(null);
  }, [open, snapshot]);

  const canSave = title.trim().length > 0 && content.trim().length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const tagArray = tags.trim() ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
    try {
      if (isEdit && snapshot) {
        // Backend supports PUT /snapshots/:id with partial fields.
        const r = await fetch(`/api/snapshots/${snapshot.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, category, content, tags: tagArray }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } else {
        await apiPost(`/projects/${projectId}/snapshots`, {
          title,
          category,
          content,
          tags: tagArray,
        });
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('projects:snapshots.editSnapshot', 'Edit snapshot')
              : t('projects:snapshots.newSnapshot')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'projects:snapshots.formDescription',
              'Use markdown — the View tab in the detail pane renders it.',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-auto space-y-3 pr-1">
          <div className="flex gap-2">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('projects:snapshots.titlePlaceholder')}
              className="flex-1"
              autoFocus
            />
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="rounded border bg-background px-2 py-1.5 text-sm"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t('projects:snapshots.contentPlaceholder')}
            rows={14}
            className="font-mono text-xs"
          />
          <Input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t('projects:snapshots.tagsPlaceholder')}
            className="text-xs"
          />
          {error && <div className="text-xs text-destructive">{error}</div>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving
              ? t('common:actions.saving', 'Saving…')
              : isEdit
                ? t('common:actions.save')
                : t('projects:snapshots.saveSnapshot')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
