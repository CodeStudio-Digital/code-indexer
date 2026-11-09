import type { EnvApplication } from './env-application.js';
import type { EnvSource, EnvAutoKind, EnvRow } from './env-row-types.js';
export type { EnvSource, EnvAutoKind, EnvRow } from './env-row-types.js';
/**
 * EnvRowEditor — single env var row: name, value (masked or plain), scope /
 * source / secret badges, per-row reveal, and edit + delete actions.
 *
 * Editing happens in EnvEditDialog (opened by the pencil icon), not inline.
 * Used by EnvTab; the edit action targets
 * `PUT /api/company/sessions/:id/envs/:key`.
 *
 * Per-row reveal (D1): the eye fetches `?reveal=1&key=<key>` so ONLY this
 * value is exposed (and audited server-side), instead of the tab-wide
 * reveal toggle that plaintexts every secret at once.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { EnvEditDialog } from './EnvEditDialog.js';
import type { EnvServiceOption } from './EnvScopeSelector.js';




function sourceLabel(source: EnvSource | undefined): string {
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

interface EnvRowEditorProps {
  row: EnvRow;
  sessionId: string;
  onSaved: (result?: EnvApplication) => Promise<void> | void;
  onDelete?: () => void;
  /** When true, the row renders read-only (managed by the sandbox). */
  managed?: boolean;
  /** Sub-label for managed rows (database / sandbox / auto). */
  autoKind?: EnvAutoKind;
  /** Session services offered by the scope selector in the edit dialog. */
  services?: EnvServiceOption[];
  /** Hide the delete button (for callers whose envs are deleted through another flow). */
  hideDelete?: boolean;
}

export function EnvRowEditor({
  row,
  sessionId,
  onSaved,
  onDelete,
  managed = false,
  autoKind = 'auto',
  services = [],
  hideDelete = false,
}: EnvRowEditorProps) {
  const { t } = useTranslation('agents');
  const [editOpen, setEditOpen] = useState(false);
  // Per-row reveal: plaintext for THIS key only, fetched on demand.
  const [shown, setShown] = useState<string | null>(null);

  async function toggleReveal(): Promise<void> {
    if (shown !== null) {
      setShown(null);
      return;
    }
    const r = await fetch(
      `/api/company/sessions/${sessionId}/envs?reveal=1&key=${encodeURIComponent(row.key)}`,
    );
    if (!r.ok) return;
    const body = (await r.json()) as { envs: EnvRow[] };
    const match = body.envs?.find((e) => e.key === row.key);
    if (match) setShown(match.value);
  }

  const scope = (row.service_scope ?? '').trim();
  const scopeText = scope || t('env.scopeAll');

  return (
    <div className="flex items-center gap-2 p-2 text-xs">
      <span className="font-mono font-medium min-w-[160px] truncate">{row.key}</span>
      <span className="flex-1 font-mono text-muted-foreground truncate">
        {shown ?? (row.masked ? '••••••••' : row.value || '(empty)')}
      </span>
      {(scope || !managed) && (
        <span
          className="text-[9px] font-mono text-muted-foreground border rounded px-1 py-px max-w-[110px] truncate shrink-0"
          title={t('env.scopeTitle', { scope: scopeText })}
        >
          {scopeText}
        </span>
      )}
      {row.masked && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void toggleReveal()}
          title={shown !== null ? t('env.hideValue') : t('env.revealValue')}
        >
          {shown !== null ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        </Button>
      )}
      {managed ? (
        <span
          className="text-[9px] uppercase text-muted-foreground tracking-wide"
          title="Auto-managed by the sandbox; regenerated when services change."
        >
          {t(`env.autoKind_${autoKind}`)}
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
            services={services}
            open={editOpen}
            onOpenChange={setEditOpen}
            onSaved={onSaved}
          />
        </>
      )}
    </div>
  );
}
