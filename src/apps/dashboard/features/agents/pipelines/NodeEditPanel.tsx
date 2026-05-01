/**
 * Side panel that edits a single pipeline node. The graph is the source
 * of truth — every change is forwarded back through `onChange(patch)`
 * and the builder applies it to the underlying `PipelineNode`.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Textarea } from '../../../components/ui/textarea.js';
import type { KanbanColumn, KanbanTag } from '../../../../../core/coder/company/types.js';
import { KANBAN_COLUMNS } from '../../../../../core/coder/company/types.js';
import type { PipelineNode } from './PipelineBuilder.js';

const KANBAN_TAGS: KanbanTag[] = ['bug', 'feature', 'refactor', 'documentation'];
const BRANCH_MODES: NonNullable<PipelineNode['branchMode']>[] = ['linear', 'pass-fail', 'by-tag', 'by-text-match'];

interface NodeEditPanelProps {
  node: PipelineNode;
  availableRoles: string[];
  availableSkills: string[];
  onChange: (patch: Partial<PipelineNode>) => void;
  onDelete: () => void;
}

export function NodeEditPanel({
  node,
  availableRoles,
  availableSkills,
  onChange,
  onDelete,
}: NodeEditPanelProps) {
  const { t } = useTranslation(['agents', 'common']);

  return (
    <aside className="w-80 border-l overflow-auto">
      <div className="border-b px-3 py-2 flex items-center justify-between">
        <span className="font-medium text-sm">{t('agents:pipelines.node.title')}</span>
        <Button size="sm" variant="ghost" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="p-3 space-y-3 text-xs">
        <Field label={t('agents:pipelines.node.id')}>
          <Input value={node.id} disabled className="h-7" />
        </Field>

        <Field label={t('agents:pipelines.node.label')}>
          <Input
            value={node.label}
            onChange={(e) => onChange({ label: e.target.value })}
            className="h-7"
          />
        </Field>

        <Field label={t('agents:pipelines.node.role')}>
          <select
            value={node.role}
            onChange={(e) => onChange({ role: e.target.value })}
            className="w-full h-7 rounded border bg-background px-2"
          >
            {availableRoles.length === 0 && (
              <option value={node.role}>{node.role}</option>
            )}
            {availableRoles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('agents:pipelines.node.taskTemplate')}>
          <Textarea
            value={node.taskTemplate}
            onChange={(e) => onChange({ taskTemplate: e.target.value })}
            rows={6}
            className="font-mono text-[11px]"
          />
          <div className="text-[10px] text-muted-foreground mt-1">
            {t('agents:pipelines.node.taskHelp')}
          </div>
        </Field>

        <Field label={t('agents:pipelines.node.branchMode')}>
          <select
            value={node.branchMode ?? 'linear'}
            onChange={(e) =>
              onChange({ branchMode: e.target.value as PipelineNode['branchMode'] })
            }
            className="w-full h-7 rounded border bg-background px-2"
          >
            {BRANCH_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('agents:pipelines.node.kanbanTag')}>
          <select
            value={node.kanbanTag ?? ''}
            onChange={(e) =>
              onChange({ kanbanTag: (e.target.value || null) as KanbanTag | null })
            }
            className="w-full h-7 rounded border bg-background px-2"
          >
            <option value="">—</option>
            {KANBAN_TAGS.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('agents:pipelines.node.kanbanColumnTarget')}>
          <select
            value={node.kanbanColumnTarget ?? ''}
            onChange={(e) =>
              onChange({
                kanbanColumnTarget: (e.target.value || undefined) as KanbanColumn | undefined,
              })
            }
            className="w-full h-7 rounded border bg-background px-2"
          >
            <option value="">—</option>
            {KANBAN_COLUMNS.map((col) => (
              <option key={col} value={col}>
                {col}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('agents:pipelines.node.maxAttempts')}>
          <Input
            type="number"
            min={1}
            max={20}
            value={node.maxAttempts ?? 3}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              onChange({ maxAttempts: Number.isFinite(n) ? n : 3 });
            }}
            className="h-7"
          />
          <div className="text-[10px] text-muted-foreground mt-1">
            {t('agents:pipelines.node.maxAttemptsHelp')}
          </div>
        </Field>

        <Field label={t('agents:pipelines.node.extraSkills')}>
          <SkillPicker
            available={availableSkills}
            selected={node.extraSkills ?? []}
            onChange={(next) => onChange({ extraSkills: next })}
          />
        </Field>

        <Field label={t('agents:pipelines.node.projectId')}>
          <Input
            type="number"
            placeholder="—"
            value={node.projectId ?? ''}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              onChange({ projectId: Number.isFinite(n) ? n : undefined });
            }}
            className="h-7"
          />
        </Field>
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function SkillPicker({
  available,
  selected,
  onChange,
}: {
  available: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (skill: string) => {
    if (selected.includes(skill)) onChange(selected.filter((s) => s !== skill));
    else onChange([...selected, skill]);
  };
  if (available.length === 0) {
    return <div className="text-[10px] text-muted-foreground">—</div>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {available.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => toggle(s)}
          className={`rounded-full border px-2 py-0.5 text-[10px] ${
            selected.includes(s) ? 'bg-primary text-primary-foreground' : 'bg-background'
          }`}
        >
          {s}
        </button>
      ))}
    </div>
  );
}
