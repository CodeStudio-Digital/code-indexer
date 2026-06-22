/**
 * Environment editor (modal): manage per-project environments — base_url +
 * `{{var}}` variables with a per-variable secret flag. Secrets are stored
 * server-side; this editor sends values on save but the list view masks them.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  /** Env to edit; null = create a new one. */
  editId: number | null;
}

export function EnvEditor({ projectId, environments, open, onOpenChange, onChanged, editId }: Props) {
  const { t } = useTranslation('apiClient');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [vars, setVars] = useState<EnvVariable[]>([]);

  const load = (env: ApiEnvironment | null) => {
    setName(env?.name ?? '');
    setBaseUrl(env?.base_url ?? '');
    setIsDefault(env?.is_default ?? environments.length === 0);
    setVars(env ? parseVars(env.variables_json) : []);
  };

  useEffect(() => {
    if (open) load(editId == null ? null : environments.find((e) => e.id === editId) ?? null);
  }, [open, editId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{editId == null ? t('env.newTitle') : t('env.editTitle')}</DialogTitle></DialogHeader>

        <div className="space-y-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('env.namePlaceholder')} className="h-8 text-sm" />
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:3000" className="h-8 text-sm font-mono" />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> {t('env.defaultEnvironment')}
          </label>
        </div>

        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">{t('env.variables')}</div>
          {vars.map((v, i) => (
            <div key={i} className="flex gap-1 items-center">
              <Input value={v.key} placeholder={t('env.keyPlaceholder')} className="h-7 text-xs font-mono w-32"
                onChange={(e) => setVars((p) => p.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} />
              <Input value={v.value} placeholder={t('env.valuePlaceholder')} type={v.secret ? 'password' : 'text'} className="h-7 text-xs font-mono flex-1"
                onChange={(e) => setVars((p) => p.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
              <label className="flex items-center gap-1 text-[10px] text-muted-foreground" title={t('env.maskValue')}>
                <input type="checkbox" checked={v.secret}
                  onChange={(e) => setVars((p) => p.map((x, j) => j === i ? { ...x, secret: e.target.checked } : x))} /> {t('env.secret')}
              </label>
              <button className="text-muted-foreground hover:text-red-500" onClick={() => setVars((p) => p.filter((_, j) => j !== i))}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <Button size="sm" variant="ghost" className="h-6 text-xs gap-1"
            onClick={() => setVars((p) => [...p, { key: '', value: '', secret: false }])}>
            <Plus className="h-3 w-3" /> {t('env.addVariable')}
          </Button>
        </div>

        <div className="flex justify-between pt-2">
          {editId != null
            ? <Button variant="ghost" size="sm" className="text-red-500" onClick={remove}>{t('env.delete')}</Button>
            : <span />}
          <Button size="sm" onClick={save}>{t('env.save')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
