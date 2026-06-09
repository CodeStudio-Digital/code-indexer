/**
 * EnvRowEditor — single env var row: name, value (masked or plain), source /
 * secret badges, and edit + delete actions.
 *
 * Editing happens in EnvEditDialog (opened by the pencil icon), not inline.
 * Reused by EnvTab and DatabasesTab; the edit action targets
 * `PUT /api/company/sessions/:id/envs/:key`, so the Databases tab needs no
 * dedicated mutation path — connection-string edits flow through the same
 * endpoint as any other env var.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { EnvEditDialog } from './EnvEditDialog.js';

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
  const { t } = useTranslation('agents');
  const [editOpen, setEditOpen] = useState(false);

  return (
    <div className="flex items-center gap-2 p-2 text-xs">
      <span className="font-mono font-medium min-w-[160px] truncate">{row.key}</span>
      <span className="flex-1 font-mono text-muted-foreground truncate">
        {row.masked ? '••••••••' : row.value || '(empty)'}
      </span>
      {managed ? (
        <span
          className="text-[9px] uppercase text-muted-foreground tracking-wide"
          title="Auto-managed by the sandbox; regenerated when services change."
        >
          auto
        </span>
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
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditOpen(true)}
            title={t('env.edit')}
          >
            <Pencil className="h-3 w-3" />
          </Button>
          {!hideDelete && onDelete && (
            <Button size="sm" variant="ghost" onClick={onDelete} title="Delete">
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
          <EnvEditDialog
            row={row}
            sessionId={sessionId}
            open={editOpen}
            onOpenChange={setEditOpen}
            onSaved={onSaved}
          />
        </>
      )}
    </div>
  );
}
