/**
 * EnvRowEditor — single env var row with inline edit + masking.
 *
 * Extracted from EnvTab so the Databases tab can reuse it to display
 * the env vars associated with each registered database. The edit
 * action goes straight to `PUT /api/company/sessions/:id/envs/:key`,
 * so the Databases tab does not need a dedicated mutation path —
 * connection-string edits flow through the same endpoint as any other
 * env var.
 */

import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';

export type EnvSource = 'user' | 'imported' | 'auto' | 'agent';

export interface EnvRow {
  key: string;
  value: string;
  is_secret: boolean;
  masked: boolean;
  source?: EnvSource;
  updated_at: string;
}

export function sourceLabel(source: EnvSource | undefined): string {
  switch (source) {
    case 'imported':
      return 'imported from .env';
    case 'auto':
      return 'managed by sandbox';
    case 'agent':
      return 'set by agent';
    default:
      return 'user';
  }
}

export interface EnvRowEditorProps {
  row: EnvRow;
  sessionId: number;
  onSaved: () => Promise<void> | void;
  onDelete?: () => void;
  /** When true, the row renders read-only (managed by the sandbox). */
  managed?: boolean;
  /** Hide the delete button (used by DatabasesTab where envs are deleted with the DB). */
  hideDelete?: boolean;
}

export function EnvRowEditor({
  row,
  sessionId,
  onSaved,
  onDelete,
  managed = false,
  hideDelete = false,
}: EnvRowEditorProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.value);
  const [isSecret, setIsSecret] = useState(row.is_secret);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(row.value);
    setIsSecret(row.is_secret);
  }, [row.value, row.is_secret]);

  async function save() {
    setSaving(true);
    try {
      await fetch(`/api/company/sessions/${sessionId}/envs/${encodeURIComponent(row.key)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value, is_secret: isSecret }),
      });
      setEditing(false);
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2 p-2 text-xs">
      <span className="font-mono font-medium min-w-[160px] truncate">{row.key}</span>
      {editing ? (
        <input
          className="flex-1 text-xs bg-background border rounded px-1.5 py-1 font-mono"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
      ) : (
        <span className="flex-1 font-mono text-muted-foreground truncate">
          {row.masked ? '••••••••' : row.value || '(empty)'}
        </span>
      )}
      {managed ? (
        <span
          className="text-[9px] uppercase text-muted-foreground tracking-wide"
          title="Auto-managed by the sandbox; regenerated when services change."
        >
          auto
        </span>
      ) : editing ? (
        <>
          <label className="flex items-center gap-1 text-[10px]">
            <input
              type="checkbox"
              checked={isSecret}
              onChange={(e) => setIsSecret(e.target.checked)}
            />
            secret
          </label>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          {row.source && row.source !== 'user' && (
            <span
              className="text-[9px] uppercase text-muted-foreground tracking-wide"
              title={sourceLabel(row.source)}
            >
              {row.source}
            </span>
          )}
          {row.is_secret && (
            <span className="text-[9px] uppercase text-muted-foreground tracking-wide">secret</span>
          )}
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
          {!hideDelete && onDelete && (
            <Button size="sm" variant="ghost" onClick={onDelete} title="Delete">
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </>
      )}
    </div>
  );
}
