/**
 * Side panel that edits a single pipeline edge. Edge `kind` is a
 * union — switching kinds rebuilds the discriminant fields so the
 * resulting object stays well-typed for the validator.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { HelpCircle, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../../components/ui/tooltip.js';
import type { KanbanTag } from '../../../../../core/coder/company/types.js';
import type { PipelineEdge } from './PipelineBuilder.js';

const KANBAN_TAGS: KanbanTag[] = ['bug', 'feature', 'refactor', 'documentation'];

interface EdgeEditPanelProps {
  edge: PipelineEdge;
  onChange: (next: PipelineEdge) => void;
  onDelete: () => void;
}

export function EdgeEditPanel({ edge, onChange, onDelete }: EdgeEditPanelProps) {
  const { t } = useTranslation(['agents', 'common']);

  const switchKind = (kind: PipelineEdge['kind']) => {
    const base = { id: edge.id, from: edge.from, to: edge.to };
    switch (kind) {
      case 'linear':
        onChange({ kind: 'linear', ...base });
        return;
      case 'pass-fail':
        onChange({ kind: 'pass-fail', ...base, on: 'pass' });
        return;
      case 'by-tag':
        onChange({ kind: 'by-tag', ...base, tag: 'feature' });
        return;
      case 'by-text-match':
        onChange({ kind: 'by-text-match', ...base, pattern: '' });
        return;
    }
  };

  return (
    <TooltipProvider>
    <aside className="w-80 border-l overflow-auto bg-card/40">
      <div className="border-b px-3 py-2 flex items-center justify-between sticky top-0 bg-card/95 backdrop-blur z-10">
        <span className="font-medium text-sm">{t('agents:pipelines.edge.title')}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={onDelete}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            {t('agents:pipelines.edge.deleteTip', { defaultValue: 'Remove this wire.' })}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="p-3 space-y-3 text-xs">
        <Field
          label={t('agents:pipelines.edge.kind')}
          hint={t('agents:pipelines.edge.kindTip', {
            defaultValue:
              'linear: always advance. pass-fail: route by validator verdict. by-tag: kanban tag. by-text-match: regex over agent output.',
          })}
        >
          <select
            value={edge.kind}
            onChange={(e) => switchKind(e.target.value as PipelineEdge['kind'])}
            className="w-full h-7 rounded border bg-background px-2"
          >
            <option value="linear">linear</option>
            <option value="pass-fail">pass-fail</option>
            <option value="by-tag">by-tag</option>
            <option value="by-text-match">by-text-match</option>
          </select>
        </Field>

        {edge.kind === 'pass-fail' && (
          <Field label={t('agents:pipelines.edge.on')}>
            <select
              value={edge.on}
              onChange={(e) =>
                onChange({ ...edge, on: e.target.value as 'pass' | 'fail' | 'review' })
              }
              className="w-full h-7 rounded border bg-background px-2"
            >
              <option value="pass">pass</option>
              <option value="fail">fail</option>
              <option value="review">review</option>
            </select>
            <div className="text-[10px] text-muted-foreground mt-1">
              {t('agents:pipelines.edge.onReviewHelp')}
            </div>
          </Field>
        )}

        {edge.kind === 'by-tag' && (
          <Field label={t('agents:pipelines.edge.tag')}>
            <select
              value={edge.tag}
              onChange={(e) => onChange({ ...edge, tag: e.target.value as KanbanTag })}
              className="w-full h-7 rounded border bg-background px-2"
            >
              {KANBAN_TAGS.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </Field>
        )}

        {edge.kind === 'by-text-match' && (
          <Field label={t('agents:pipelines.edge.pattern')}>
            <Input
              value={edge.pattern}
              onChange={(e) => onChange({ ...edge, pattern: e.target.value })}
              className="h-7 font-mono"
              placeholder="^OK$"
            />
            <div className="text-[10px] text-muted-foreground mt-1">
              {t('agents:pipelines.edge.patternHelp')}
            </div>
          </Field>
        )}

        <div className="rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground">
          {edge.from} → {edge.to}
        </div>
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
