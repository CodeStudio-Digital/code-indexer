/**
 * Secrets manager — named `${secret:NAME}` values a snippet can reference
 * (migration 197). Values are WRITE-ONLY: the stored ciphertext is never
 * decrypted for display; editing offers "replace value" (blank = keep). Stored
 * cifrado no chaveiro do SO, só neste dispositivo. Embedded in SnippetsPanel.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2, Loader2, KeyRound } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { confirm } from '../../../components/ui/prompt-dialog.js';
import { createSecret, patchSecret, deleteSecret } from '../api.js';
import type { SshSecret } from '../types.js';

interface Props {
  projectId: number;
  secrets: SshSecret[];
  /** Refetch after a mutation so the parent's insert-dropdown stays in sync. */
  onChange: () => void;
}

export function SecretsManager({ projectId, secrets, onChange }: Props) {
  const { t } = useTranslation('ssh');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset(): void {
    setShowForm(false);
    setEditingId(null);
    setName('');
    setValue('');
    setDescription('');
    setError(null);
  }

  function openNew(): void {
    reset();
    setShowForm(true);
  }

  function openEdit(s: SshSecret): void {
    setEditingId(s.id);
    setName(s.name);
    setValue(''); // write-only: blank means "keep current value"
    setDescription(s.description ?? '');
    setError(null);
    setShowForm(true);
  }

  async function save(): Promise<void> {
    if (!name.trim()) return;
    if (editingId == null && !value) return; // new secret needs a value
    setBusy(true);
    setError(null);
    try {
      if (editingId != null) {
        await patchSecret(projectId, editingId, {
          name: name.trim(),
          description: description.trim() || null,
          ...(value ? { value } : {}),
        });
      } else {
        await createSecret(projectId, name.trim(), value, description.trim() || undefined);
      }
      reset();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-b bg-card/20">
      <div className="h-7 flex items-center gap-2 px-2">
        <KeyRound className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="text-[11px] font-medium text-muted-foreground shrink-0">{t('secrets.title')}</span>
        <button
          type="button"
          onClick={() => (showForm && editingId == null ? reset() : openNew())}
          className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          <Plus className="h-3 w-3" />
          {t('secrets.new')}
        </button>
      </div>

      {showForm && (
        <div className="px-2 pb-2 grid gap-1.5">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('secrets.namePlaceholder')} className="h-7 font-mono text-xs" />
          <Input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={editingId != null ? t('secrets.valueKeep') : t('secrets.valuePlaceholder')}
            className="h-7 text-xs"
          />
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('secrets.descPlaceholder')} className="h-7 text-xs" />
          {error && <p className="text-[10px] text-red-500">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={reset} disabled={busy}>{t('dialog.cancel')}</Button>
            <Button size="sm" onClick={save} disabled={busy || !name.trim() || (editingId == null && !value)}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('secrets.save')}
            </Button>
          </div>
        </div>
      )}

      {secrets.length > 0 && (
        <div className="max-h-32 overflow-y-auto">
          {secrets.map((s) => (
            <div key={s.id} className="flex items-center gap-2 px-3 py-1 text-[11px] group">
              <code className="shrink-0 text-foreground">${'{'}secret:{s.name}{'}'}</code>
              {s.description && <span className="truncate text-muted-foreground">{s.description}</span>}
              <button
                type="button"
                aria-label={t('panel.edit')}
                title={t('panel.edit')}
                onClick={() => openEdit(s)}
                className="ml-auto shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100 text-muted-foreground hover:text-foreground p-0.5"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label={t('panel.delete')}
                title={t('panel.delete')}
                onClick={async () => {
                  if (!(await confirm({
                    title: t('secrets.deleteConfirm', { name: s.name }),
                    description: t('secrets.deleteConfirmBody'),
                    confirmLabel: t('panel.delete'),
                    tone: 'destructive',
                  }))) return;
                  await deleteSecret(projectId, s.id);
                  onChange();
                }}
                className="shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100 text-muted-foreground hover:text-red-500 p-0.5"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
