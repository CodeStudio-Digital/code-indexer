import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Switch } from '../../components/ui/switch.js';
import type { FieldSpec } from './storage-api.js';

/**
 * Generic config dialog shared between embeddings and vector stores.
 *
 * The list of fields is driven by `fields` (FieldSpec[]) so the same
 * component renders the right inputs for Cloudflare, Qdrant, OpenSearch,
 * Pinecone, etc. — without the caller hardcoding per-kind forms.
 *
 * Existing config values are pre-populated; password fields are rendered
 * as plain inputs (not pre-filled with masked dots) so the user has to
 * re-type to change them — same pattern as the provider EditDialog.
 */
interface StorageConfig {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  is_default: boolean;
  config: Record<string, unknown>;
}

interface StorageConfigDialogProps<K extends string> {
  title: string;
  initial: Partial<StorageConfig> & { kind: K };
  kinds: Array<{ value: K; label: string }>;
  fieldsByKind: Record<K, FieldSpec[]>;
  onClose: () => void;
  onSave: (c: StorageConfig) => void;
}

export function StorageConfigDialog<K extends string>({
  title,
  initial,
  kinds,
  fieldsByKind,
  onClose,
  onSave,
}: StorageConfigDialogProps<K>) {
  const isNew = !initial.id;
  const [form, setForm] = useState<Partial<StorageConfig> & { kind: K }>({
    enabled: true,
    is_default: false,
    config: {},
    ...initial,
  });

  const fields = fieldsByKind[form.kind] ?? [];

  function update<Key extends keyof typeof form>(k: Key, v: (typeof form)[Key]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function updateConfig(key: string, value: string) {
    setForm((f) => ({ ...f, config: { ...(f.config ?? {}), [key]: value } }));
  }

  function submit() {
    const payload: StorageConfig = {
      id: form.id ?? '',
      kind: form.kind,
      name: form.name ?? form.id ?? '',
      enabled: !!form.enabled,
      is_default: !!form.is_default,
      config: form.config ?? {},
    };
    onSave(payload);
  }

  const missingRequired = fields.some(
    (f) => f.required && !((form.config?.[f.key] as string | undefined) ?? '').trim(),
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isNew ? `Add ${title}` : `Edit ${initial.name ?? initial.id}`}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium">ID</label>
              <Input
                disabled={!isNew}
                value={form.id ?? ''}
                onChange={(e) =>
                  update('id', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
                }
                placeholder="my-backend"
              />
            </div>
            <div>
              <label className="text-xs font-medium">Display name</label>
              <Input
                value={form.name ?? ''}
                onChange={(e) => update('name', e.target.value)}
                placeholder="My Backend"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium">Kind</label>
            <Select value={form.kind} onValueChange={(v) => update('kind', v as K)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {kinds.map((k) => (
                  <SelectItem key={k.value} value={k.value}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {fields.map((f) => {
            const value = ((form.config?.[f.key] as string | undefined) ?? '').toString();
            if (f.type === 'select') {
              return (
                <div key={f.key}>
                  <label className="text-xs font-medium">
                    {f.label} {f.required && <span className="text-destructive">*</span>}
                  </label>
                  <Select value={value} onValueChange={(v) => updateConfig(f.key, v)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select…" />
                    </SelectTrigger>
                    <SelectContent>
                      {f.options?.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            }
            return (
              <div key={f.key}>
                <label className="text-xs font-medium">
                  {f.label} {f.required && <span className="text-destructive">*</span>}
                </label>
                <Input
                  type={f.type === 'password' ? 'password' : 'text'}
                  value={value}
                  onChange={(e) => updateConfig(f.key, e.target.value)}
                  placeholder={f.placeholder}
                />
              </div>
            );
          })}

          <div className="flex items-center gap-6 pt-2">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={!!form.enabled}
                onCheckedChange={(v) => update('enabled', v)}
              />
              Enabled
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={!!form.is_default}
                onCheckedChange={(v) => update('is_default', v)}
              />
              Default
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!form.id || !form.kind || missingRequired}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
