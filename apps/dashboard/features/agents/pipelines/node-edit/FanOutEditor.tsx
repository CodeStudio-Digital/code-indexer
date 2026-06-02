/**
 * Editor for a `kind: 'fan-out'` node. Two modes:
 *   - each-project — one branch per project in the session, all using the
 *     chosen role + the node's taskTemplate.
 *   - explicit     — a hand-authored list of branches (role / projectId /
 *     label / optional taskTemplate override).
 * Company scope only (chat pipelines are single-project).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../../../../components/ui/button.js';
import { Input } from '../../../../components/ui/input.js';
import { Textarea } from '../../../../components/ui/textarea.js';
import type { PipelineNode } from '@mcp/company/types.js';

type FanOut = NonNullable<PipelineNode['fanOut']>;
type Branch = NonNullable<FanOut['branches']>[number];

interface FanOutEditorProps {
  fanOut: FanOut | undefined;
  availableRoles: string[];
  onChange: (patch: Partial<PipelineNode>) => void;
}

export function FanOutEditor({ fanOut, availableRoles, onChange }: FanOutEditorProps) {
  const { t } = useTranslation('agents');
  const mode = fanOut?.mode ?? 'each-project';
  const branches = fanOut?.branches ?? [];

  const setMode = (next: 'each-project' | 'explicit') =>
    onChange({ fanOut: { ...fanOut, mode: next, role: fanOut?.role, branches } });
  const setRole = (role: string) => onChange({ fanOut: { mode: 'each-project', role, branches } });
  const setBranches = (next: Branch[]) =>
    onChange({ fanOut: { mode: 'explicit', role: fanOut?.role, branches: next } });

  const patchBranch = (i: number, patch: Partial<Branch>) =>
    setBranches(branches.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  const addBranch = () =>
    setBranches([...branches, { role: availableRoles[0] ?? 'subordinate', label: `branch ${branches.length + 1}` }]);
  const removeBranch = (i: number) => setBranches(branches.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-2 rounded border border-dashed p-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {t('pipelines.node.fanOut.title', { defaultValue: 'Fan-out' })}
      </div>

      <div className="flex gap-2">
        <ModeBtn active={mode === 'each-project'} label={t('pipelines.node.fanOut.eachProject', { defaultValue: 'Each project' })} onSelect={() => setMode('each-project')} />
        <ModeBtn active={mode === 'explicit'} label={t('pipelines.node.fanOut.explicit', { defaultValue: 'Explicit list' })} onSelect={() => setMode('explicit')} />
      </div>

      {mode === 'each-project' ? (
        <label className="block">
          <span className="text-muted-foreground">{t('pipelines.node.fanOut.role', { defaultValue: 'Role for every project' })}</span>
          <select
            value={fanOut?.role ?? ''}
            onChange={(e) => setRole(e.target.value)}
            className="mt-1 w-full h-7 rounded border bg-background px-2"
          >
            {availableRoles.length === 0 && <option value={fanOut?.role ?? ''}>{fanOut?.role ?? '—'}</option>}
            {availableRoles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
      ) : (
        <div className="space-y-2">
          {branches.map((b, i) => (
            <div key={i} className="space-y-1 rounded border p-1.5">
              <div className="flex items-center gap-1">
                <Input value={b.label ?? ''} placeholder="label" onChange={(e) => patchBranch(i, { label: e.target.value })} className="h-6 flex-1 text-[11px]" />
                <Button size="sm" variant="ghost" onClick={() => removeBranch(i)}><Trash2 className="h-3 w-3" /></Button>
              </div>
              <div className="flex gap-1">
                <select value={b.role} onChange={(e) => patchBranch(i, { role: e.target.value })} className="h-6 flex-1 rounded border bg-background px-1 text-[11px]">
                  {availableRoles.length === 0 && <option value={b.role}>{b.role}</option>}
                  {availableRoles.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <Input type="number" value={b.projectId ?? ''} placeholder="projectId" onChange={(e) => { const n = parseInt(e.target.value, 10); patchBranch(i, { projectId: Number.isFinite(n) ? n : undefined }); }} className="h-6 w-24 text-[11px]" />
              </div>
              <Textarea value={b.taskTemplate ?? ''} placeholder={t('pipelines.node.fanOut.taskOverride', { defaultValue: 'task override (optional — defaults to node template)' })} rows={2} onChange={(e) => patchBranch(i, { taskTemplate: e.target.value || undefined })} className="font-mono text-[10px]" />
            </div>
          ))}
          <Button size="sm" variant="ghost" className="w-full text-xs justify-start" onClick={addBranch}>
            <Plus className="h-3.5 w-3.5 mr-1" /> {t('pipelines.node.fanOut.addBranch', { defaultValue: 'Add branch' })}
          </Button>
        </div>
      )}
    </div>
  );
}

function ModeBtn({ active, label, onSelect }: { active: boolean; label: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex-1 h-7 px-2 rounded border text-xs transition-colors ${
        active ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background hover:bg-muted'
      }`}
    >
      {label}
    </button>
  );
}
