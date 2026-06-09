/**
 * EnvEditDialog — modal editor for a single shared env var.
 *
 * Replaces the old inline edit in EnvRowEditor. Opened by the pencil icon on a
 * (non-managed) row. Writes through the same
 * `PUT /api/company/sessions/:id/envs/:key` endpoint as the add form, so no
 * dedicated mutation path is needed.
 *
 * Masked-secret correctness: a secret row arrives with `value === ''` and
 * `masked === true` (the list endpoint hides secret values unless `?reveal=1`).
 * Seeding the field with '' and saving would WIPE the secret, so on open we
 * fetch the revealed value for this key and seed it. Save stays disabled until
 * the real value has loaded.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Textarea } from '../../components/ui/textarea.js';
import type { EnvRow } from './EnvRowEditor.js';

interface EnvEditDialogProps {
  row: EnvRow;
  sessionId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void> | void;
}

export function EnvEditDialog({ row, sessionId, open, onOpenChange, onSaved }: EnvEditDialogProps) {
  const { t } = useTranslation('agents');
  const [value, setValue] = useState(row.value);
  const [isSecret, setIsSecret] = useState(row.is_secret);
  const [saving, setSaving] = useState(false);
  // For a masked secret the real value is fetched on open; block Save until then.
  const [loadingValue, setLoadingValue] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Reseed from the row each time the dialog opens.
    setValue(row.value);
    setIsSecret(row.is_secret);
    if (!row.masked) return;
    // Secret + not revealed → row.value is ''. Fetch the real value so saving
    // doesn't blank the secret.
    let cancelled = false;
    setLoadingValue(true);
    void (async () => {
      try {
        const r = await fetch(`/api/company/sessions/${sessionId}/envs?reveal=1`);
        if (r.ok) {
          const body = (await r.json()) as { envs: EnvRow[] };
          const match = body.envs?.find((e) => e.key === row.key);
          if (!cancelled && match) setValue(match.value);
        }
      } finally {
        if (!cancelled) setLoadingValue(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, row.key, row.value, row.is_secret, row.masked, sessionId]);

  async function save() {
    setSaving(true);
    try {
      await fetch(`/api/company/sessions/${sessionId}/envs/${encodeURIComponent(row.key)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value, is_secret: isSecret }),
      });
      await onSaved();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm break-all">
            {t('env.editTitle', { key: row.key })}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Textarea
            className="font-mono text-xs min-h-[96px]"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t('env.valuePlaceholder')}
            autoFocus
          />
          <label className="flex items-center gap-2 text-xs cursor-pointer w-fit">
            <input
              type="checkbox"
              checked={isSecret}
              onChange={(e) => setIsSecret(e.target.checked)}
            />
            <span>{t('env.secret')}</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={save} disabled={saving || loadingValue}>
            {saving ? t('env.saving') : t('env.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
