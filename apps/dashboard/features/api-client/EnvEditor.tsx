/**
 * Environment editor (modal): manage per-project environments — base_url +
 * `{{var}}` variables with a per-variable secret flag. Secrets are stored
 * server-side; this editor sends values on save but the list view masks them.
 */
import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import * as api from './api.js';
import type { ApiEnvironment, EnvVariable } from './types.js';

function parseVars(json: string): EnvVariable[] {
  try {
    const obj = JSON.parse(json) as Record<string, { value?: string; secret?: boolean } | string>;
    return Object.entries(obj).map(([key, v]) => typeof v === 'string'
      ? { key, value: v, secret: false }
      : { key, value: String(v?.value ?? ''), secret: !!v?.secret });
  } catch { return []; }
}
function toVarsObject(vars: EnvVariable[]): Record<string, { value: string; secret: boolean }> {
  const out: Record<string, { value: string; secret: boolean }> = {};
  for (const v of vars) if (v.key.trim()) out[v.key.trim()] = { value: v.value, secret: v.secret };
  return out;
}

interface Props {
  projectId: number;
  environments: ApiEnvironment[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onChanged: () => void;
}

export function EnvEditor({ projectId, environments, open, onOpenChange, onChanged }: Props) {
  const [editId, setEditId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [vars, setVars] = useState<EnvVariable[]>([]);

  const load = (env: ApiEnvironment | null) => {
    setEditId(env?.id ?? null);
    setName(env?.name ?? '');
    setBaseUrl(env?.base_url ?? '');
    setIsDefault(env?.is_default ?? environments.length === 0);
    setVars(env ? parseVars(env.variables_json) : []);
  };

  useEffect(() => { if (open) load(environments[0] ?? null); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!name.trim()) return;
    await api.upsertEnvironment(projectId, {
      id: editId ?? undefined, name: name.trim(), base_url: baseUrl,
      variables: toVarsObject(vars), is_default: isDefault,
    });
    onChanged();
    onOpenChange(false);
  };
  const remove = async () => {
    if (editId == null) return;
    await api.deleteEnvironment(projectId, editId);
    onChanged();
    load(environments.find((e) => e.id !== editId) ?? null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Environments</DialogTitle></DialogHeader>

        <div className="flex gap-2 flex-wrap">
          {environments.map((e) => (
            <button key={e.id} onClick={() => load(e)}
              className={`text-xs px-2 py-1 rounded border ${editId === e.id ? 'bg-muted' : ''}`}>
              {e.name}{e.is_default ? ' ★' : ''}
            </button>
          ))}
          <button onClick={() => load(null)} className="text-xs px-2 py-1 rounded border border-dashed">+ New</button>
        </div>

        <div className="space-y-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Environment name" className="h-8 text-sm" />
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:3000" className="h-8 text-sm font-mono" />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> Default environment
          </label>
        </div>

        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">Variables</div>
          {vars.map((v, i) => (
            <div key={i} className="flex gap-1 items-center">
              <Input value={v.key} placeholder="key" className="h-7 text-xs font-mono w-32"
                onChange={(e) => setVars((p) => p.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} />
              <Input value={v.value} placeholder="value" type={v.secret ? 'password' : 'text'} className="h-7 text-xs font-mono flex-1"
                onChange={(e) => setVars((p) => p.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
              <label className="flex items-center gap-1 text-[10px] text-muted-foreground" title="Mask this value">
                <input type="checkbox" checked={v.secret}
                  onChange={(e) => setVars((p) => p.map((x, j) => j === i ? { ...x, secret: e.target.checked } : x))} /> secret
              </label>
              <button className="text-muted-foreground hover:text-red-500" onClick={() => setVars((p) => p.filter((_, j) => j !== i))}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <Button size="sm" variant="ghost" className="h-6 text-xs gap-1"
            onClick={() => setVars((p) => [...p, { key: '', value: '', secret: false }])}>
            <Plus className="h-3 w-3" /> Add variable
          </Button>
        </div>

        <div className="flex justify-between pt-2">
          {editId != null
            ? <Button variant="ghost" size="sm" className="text-red-500" onClick={remove}>Delete</Button>
            : <span />}
          <Button size="sm" onClick={save}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
