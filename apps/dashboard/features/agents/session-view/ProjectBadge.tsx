import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderGit2, X } from 'lucide-react';
import { Badge } from '../../../components/ui/badge.js';
import { toast } from '../../../components/ui/prompt-dialog.js';

interface ProjectBadgeProps {
  projectId: number;
  name: string;
  label: string | null;
  isService?: boolean;
  onRenamed: () => void;
  onDelete: () => void | Promise<void>;
  canDelete: boolean;
}

/**
 * Project chip with inline rename — click the name, edit, Enter/blur
 * commits via `PATCH /api/projects/:id`. Keeps the synthetic
 * `_BUILDER_<uuid>` IDs in the DB (they're used as idempotency keys by
 * the session delete cleanup) while letting users give them human names
 * they actually recognize.
 *
 * On double-click anywhere on the chip, and on the pencil icon, the
 * input takes focus. Escape discards; empty strings are rejected at
 * the API layer (projects.name has a NOT NULL + UNIQUE constraint).
 */
export function ProjectBadge({
  projectId,
  name,
  label,
  isService,
  onRenamed,
  onDelete,
  canDelete,
}: ProjectBadgeProps) {
  const { t } = useTranslation('agents');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);

  useEffect(() => setValue(name), [name]);

  async function save() {
    const trimmed = value.trim();
    if (!trimmed || trimmed === name) {
      setEditing(false);
      setValue(name);
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (r.ok) {
        onRenamed();
        setEditing(false);
      } else {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        toast.error(t('company.renameProjectFailed'), {
          description: body.error ?? `HTTP ${r.status}`,
        });
        setValue(name);
      }
    } catch (error) {
      toast.error(t('company.renameProjectFailed'), { description: String(error) });
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 bg-background">
        <FolderGit2 className="h-2.5 w-2.5 text-muted-foreground" />
        <input
          className="text-[10px] bg-transparent outline-none w-40"
          value={value}
          autoFocus
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') {
              setValue(name);
              setEditing(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <Badge
      variant="outline"
      className="text-[10px] gap-1 group/badge hover:bg-muted/50"
    >
      <FolderGit2
        className="h-2.5 w-2.5 cursor-pointer"
        onClick={() => setEditing(true)}
      />
      <span
        className="truncate max-w-[180px] cursor-pointer"
        title="Click to rename"
        onClick={() => setEditing(true)}
        onDoubleClick={() => setEditing(true)}
      >
        {name}
      </span>
      {label && <span className="text-muted-foreground">({label})</span>}
      {canDelete && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); void onDelete(); }}
          className="ml-0.5 opacity-0 group-hover/badge:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
          title={isService ? 'Remove microservice (destroys container)' : 'Unlink project from session'}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </Badge>
  );
}
