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
import { KINDS, type AdminProvider, type ProviderKind } from './types.js';

interface EditDialogProps {
  initial: Partial<AdminProvider>;
  onClose: () => void;
  onSave: (p: Partial<AdminProvider>) => void;
}

export function EditDialog({ initial, onClose, onSave }: EditDialogProps) {
  const isNew = !initial.id;
  const [form, setForm] = useState<Partial<AdminProvider> & { api_key?: string }>({
    ...initial,
    api_key: '', // Never pre-fill; blank means "leave existing".
  });

  function update<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function submit() {
    const payload: Partial<AdminProvider> & { api_key?: string } = {
      id: form.id,
      name: form.name,
      kind: form.kind,
      base_url: form.base_url || null,
      auth_mode: form.auth_mode,
      enabled: form.enabled,
      use_for_agent: form.use_for_agent,
      use_for_coder: form.use_for_coder,
      is_default: form.is_default,
    };
    // Only send api_key when the user typed something — avoids clobbering an
    // existing key with an empty string on edit.
    if (form.api_key && form.api_key.length > 0) payload.api_key = form.api_key;
    onSave(payload);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Add Provider' : `Edit ${initial.name}`}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium">ID</label>
              <Input
                disabled={!isNew}
                value={form.id ?? ''}
                onChange={(e) => update('id', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                placeholder="meridian"
              />
            </div>
            <div>
              <label className="text-xs font-medium">Display name</label>
              <Input
                value={form.name ?? ''}
                onChange={(e) => update('name', e.target.value)}
                placeholder="Meridian"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium">Kind</label>
            <Select value={form.kind} onValueChange={(v) => update('kind', v as ProviderKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium">Base URL (optional)</label>
            <Input
              value={form.base_url ?? ''}
              onChange={(e) => update('base_url', e.target.value)}
              placeholder="http://127.0.0.1:3456"
            />
          </div>
          <div>
            <label className="text-xs font-medium">API Key {!isNew && '(leave blank to keep)'}</label>
            <Input
              type="password"
              value={form.api_key ?? ''}
              onChange={(e) => update('api_key', e.target.value)}
              placeholder={isNew ? 'sk-…' : '••••'}
            />
          </div>
          <div className="flex items-center gap-6 pt-2">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={!!form.enabled} onCheckedChange={(v) => update('enabled', v)} />
              Enabled
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={!!form.use_for_agent} onCheckedChange={(v) => update('use_for_agent', v)} />
              Indexer
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={!!form.use_for_coder} onCheckedChange={(v) => update('use_for_coder', v)} />
              Coder
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={!!form.is_default} onCheckedChange={(v) => update('is_default', v)} />
              Default
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!form.id || !form.name || !form.kind}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
