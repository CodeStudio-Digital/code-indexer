/**
 * Side panel that edits a single pipeline node. The graph is the source
 * of truth — every change is forwarded back through `onChange(patch)`
 * and the builder applies it to the underlying `PipelineNode`.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { HelpCircle, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Textarea } from '../../../components/ui/textarea.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../../components/ui/tooltip.js';
import type { KanbanColumn, KanbanTag } from '@mcp/company/types.js';
import { KANBAN_COLUMNS } from '@mcp/company/types.js';
import type { PipelineNode } from './PipelineBuilder.js';

const KANBAN_TAGS: KanbanTag[] = ['bug', 'feature', 'refactor', 'documentation'];
const BRANCH_MODES: NonNullable<PipelineNode['branchMode']>[] = ['linear', 'pass-fail', 'by-tag', 'by-text-match'];

interface NodeEditPanelProps {
  node: PipelineNode;
  availableRoles: string[];
  availableSkills: string[];
  /**
   * Company scope shows orchestrator-only fields (role, kanban routing,
   * projectId). Chat/project pipelines ignore those at runtime, so the
   * project builder hides them to keep the panel focused on `kind`.
   */
  companyScope?: boolean;
  onChange: (patch: Partial<PipelineNode>) => void;
  onDelete: () => void;
}

export function NodeEditPanel({
  node,
  availableRoles,
  availableSkills,
  companyScope = true,
  onChange,
  onDelete,
}: NodeEditPanelProps) {
  const { t } = useTranslation(['agents', 'common']);

  const kind = node.kind ?? 'agent';
  const isValidator = kind === 'validate';

  // Validators are forced into pass-fail branching; the executor's
  // verdict ('pass'/'fail'/'review') only routes via that mode. Switching
  // kind=validate also patches branchMode so the saved graph stays
  // valid even if the user doesn't touch the branchMode dropdown.
  const switchKind = (next: 'agent' | 'validate') => {
    if (next === 'validate') {
      onChange({
        kind: 'validate',
        branchMode: 'pass-fail',
        validatorPrompt: node.validatorPrompt ?? '',
      });
    } else {
      onChange({ kind: 'agent' });
    }
  };

  return (
    <TooltipProvider>
    <aside className="w-80 border-l overflow-auto bg-card/40">
      <div className="border-b px-3 py-2 flex items-center justify-between sticky top-0 bg-card/95 backdrop-blur z-10">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-sm">{t('agents:pipelines.node.title')}</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground px-1.5 py-0.5 rounded bg-muted">
            {kind === 'validate' ? t('agents:pipelines.node.kindValidate') : t('agents:pipelines.node.kindAgent')}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={onDelete}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            {t('agents:pipelines.node.deleteTip', { defaultValue: 'Remove this stage and any wires touching it.' })}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="p-3 space-y-3 text-xs">
        <Field
          label={t('agents:pipelines.node.id')}
          hint={t('agents:pipelines.node.idTip', {
            defaultValue: 'Stable identifier used by edges. Auto-generated; cannot change.',
          })}
        >
          <Input value={node.id} disabled className="h-7" />
        </Field>

        <Field
          label={t('agents:pipelines.node.label')}
          hint={t('agents:pipelines.node.labelTip', {
            defaultValue: 'Human-friendly name shown in the canvas card.',
          })}
        >
          <Input
            value={node.label}
            onChange={(e) => onChange({ label: e.target.value })}
            className="h-7"
          />
        </Field>

        <Field
          label={t('agents:pipelines.node.kind')}
          hint={t('agents:pipelines.node.kindTip', {
            defaultValue:
              'Agent: runs as a subagent with tools. Validator: decision-only, calls submit_verdict and stops.',
          })}
        >
          <div className="flex gap-2">
            <KindRadio
              value="agent"
              current={kind}
              label={t('agents:pipelines.node.kindAgent')}
              onSelect={() => switchKind('agent')}
            />
            <KindRadio
              value="validate"
              current={kind}
              label={t('agents:pipelines.node.kindValidate')}
              onSelect={() => switchKind('validate')}
            />
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            {isValidator
              ? t('agents:pipelines.node.kindValidateHelp')
              : t('agents:pipelines.node.kindAgentHelp')}
          </div>
        </Field>

        {!isValidator && companyScope && (
          <Field
            label={t('agents:pipelines.node.role')}
            hint={t('agents:pipelines.node.roleTip', {
              defaultValue:
                'Hint shown in logs and useful when the same project has multiple stages — does not affect the model.',
            })}
          >
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
        )}

        {isValidator && (
          <>
            <Field label={t('agents:pipelines.node.validatorPrompt')}>
              <Textarea
                value={node.validatorPrompt ?? ''}
                onChange={(e) => onChange({ validatorPrompt: e.target.value })}
                rows={5}
                className="text-[11px]"
                placeholder={t('agents:pipelines.node.validatorPromptPlaceholder')}
              />
              <div className="text-[10px] text-muted-foreground mt-1">
                {t('agents:pipelines.node.validatorPromptHelp')}
              </div>
            </Field>
            <Field label={t('agents:pipelines.node.validatorTools')}>
              <ValidatorToolsPicker
                selected={node.validatorTools ?? []}
                onChange={(next) => onChange({ validatorTools: next })}
              />
              <div className="text-[10px] text-muted-foreground mt-1">
                {t('agents:pipelines.node.validatorToolsHelp')}
              </div>
            </Field>
          </>
        )}

        <Field
          label={t('agents:pipelines.node.taskTemplate')}
          hint={t('agents:pipelines.node.taskTemplateTip', {
            defaultValue:
              'Prompt sent to the stage. {{initial_input}} = user input, {{previous_output}} = previous stage output, {{vars.<id>.output}} = explicit prior stage.',
          })}
        >
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

        <Field label={t('agents:pipelines.node.requiresConfirmation')}>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={!!node.requires_confirmation}
              onChange={(e) => onChange({ requires_confirmation: e.target.checked })}
              className="h-3.5 w-3.5"
            />
            <span>{t('agents:pipelines.node.requiresConfirmationToggle')}</span>
          </label>
          <div className="text-[10px] text-muted-foreground mt-1">
            {t('agents:pipelines.node.requiresConfirmationHelp')}
          </div>
        </Field>

        <Field
          label={t('agents:pipelines.node.modelOverride')}
          hint={t('agents:pipelines.node.modelOverrideTip', {
            defaultValue:
              'Optional. Empty = inherit chat session. Useful to run validators on a cheaper model than executors.',
          })}
        >
          <div className="flex gap-2">
            <Input
              value={node.model_override?.provider ?? ''}
              onChange={(e) =>
                onChange({
                  model_override: {
                    provider: e.target.value || undefined,
                    model: node.model_override?.model,
                  },
                })
              }
              placeholder={t('agents:pipelines.node.modelOverrideProvider')}
              className="h-7 flex-1"
            />
            <Input
              value={node.model_override?.model ?? ''}
              onChange={(e) =>
                onChange({
                  model_override: {
                    provider: node.model_override?.provider,
                    model: e.target.value || undefined,
                  },
                })
              }
              placeholder={t('agents:pipelines.node.modelOverrideModel')}
              className="h-7 flex-1"
            />
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            {t('agents:pipelines.node.modelOverrideHelp')}
          </div>
        </Field>

        <Field label={t('agents:pipelines.node.branchMode')}>
          <select
            value={node.branchMode ?? 'linear'}
            disabled={isValidator}
            onChange={(e) =>
              onChange({ branchMode: e.target.value as PipelineNode['branchMode'] })
            }
            className="w-full h-7 rounded border bg-background px-2 disabled:opacity-60"
          >
            {BRANCH_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {isValidator && (
            <div className="text-[10px] text-muted-foreground mt-1">
              {t('agents:pipelines.node.branchModeValidatorLocked')}
            </div>
          )}
        </Field>

        {companyScope && (
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
        )}

        {companyScope && (
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
        )}

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

        {companyScope && (
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
        )}
      </div>
    </aside>
    </TooltipProvider>
  );
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-muted-foreground inline-flex items-center gap-1">
        {label}
        {hint && (
          <Tooltip>
            <TooltipTrigger asChild>
              <HelpCircle className="h-3 w-3 opacity-60 hover:opacity-100" />
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs">
              {hint}
            </TooltipContent>
          </Tooltip>
        )}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

/**
 * Hand-curated subset of read-only tools that are useful for validator
 * stages. Names must match what the executor builds via
 * `buildPipelineTools()` — keep in sync if that helper changes.
 */
const VALIDATOR_TOOL_OPTIONS = [
  'read_file',
  'list_directory',
  'glob',
  'web_fetch',
  'web_search',
  'get_diagnostics',
  'lsp_definition',
  'lsp_references',
  'lsp_hover',
  'lsp_diagnostics',
  'git_status',
  'git_diff',
  'git_log',
] as const;

function ValidatorToolsPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (name: string) => {
    if (selected.includes(name)) onChange(selected.filter((s) => s !== name));
    else onChange([...selected, name]);
  };
  return (
    <div className="flex flex-wrap gap-1">
      {VALIDATOR_TOOL_OPTIONS.map((name) => (
        <button
          key={name}
          type="button"
          onClick={() => toggle(name)}
          className={`rounded-full border px-2 py-0.5 text-[10px] font-mono transition-colors ${
            selected.includes(name)
              ? 'bg-primary text-primary-foreground'
              : 'bg-background hover:bg-muted'
          }`}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

function KindRadio({
  value,
  current,
  label,
  onSelect,
}: {
  value: 'agent' | 'validate';
  current: 'agent' | 'validate';
  label: string;
  onSelect: () => void;
}) {
  const active = value === current;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex-1 h-7 px-2 rounded border text-xs transition-colors ${
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-input bg-background hover:bg-muted'
      }`}
    >
      {label}
    </button>
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
