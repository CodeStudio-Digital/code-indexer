/**
 * Custom React Flow node renderer for pipeline stages.
 *
 * Replaces the default rectangle with a card that surfaces:
 *   - kind badge (Agent / Validator)
 *   - label + role
 *   - model_override chip when set
 *   - branch mode tag
 *   - requires_confirmation indicator
 *   - validator prompt preview (truncated)
 *   - dedicated handles per kind:
 *       agent     → 1 input (top), 1 output (bottom)
 *       validator → 1 input (top), 3 outputs (left=fail, center=review, right=pass)
 *
 * The wrapper styles itself by kind so users can scan a graph at a
 * glance — agent stages are blue-edged, validators are amber-edged,
 * confirmation-gated nodes get a dashed left border.
 */
import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  Bot,
  ShieldCheck,
  Cpu,
  GitBranch,
  GitFork,
  Hand,
  CheckCheck,
  AlertTriangle,
} from 'lucide-react';
import type { PipelineNode } from '@mcp/company/types.js';
import { cn } from '../../../lib/utils.js';

export interface PipelineNodeData extends Record<string, unknown> {
  pipelineNode: PipelineNode;
}

/**
 * Stable type id used by `nodeTypes` map in PipelineBuilder. Adding new
 * variants (e.g. a future "subpipeline" node) means a new type key here.
 */
export const PIPELINE_NODE_TYPE = 'pipelineNode' as const;

export function PipelineNodeView(
  props: NodeProps & { data: PipelineNodeData },
) {
  const node = props.data.pipelineNode;
  const kind = node.kind ?? 'agent';
  const isValidator = kind === 'validate';
  const isFanOut = kind === 'fan-out';
  const fanOutCount = isFanOut
    ? node.fanOut?.mode === 'explicit'
      ? node.fanOut.branches?.length ?? 0
      : null // each-project → resolved at runtime
    : 0;
  const branchMode = node.branchMode ?? 'linear';
  // Three-handle layout applies whenever the routing emits the
  // pass / fail / review triplet — that's both validator nodes (which
  // emit a structured verdict) and any agent stage configured with
  // `branchMode: 'pass-fail'` (regex over the agent's final text).
  const hasPassFailHandles = branchMode === 'pass-fail';
  const hasOverride = !!(
    node.model_override?.provider || node.model_override?.model
  );
  const validatorPromptPreview = isValidator
    ? (node.validatorPrompt ?? '').trim().slice(0, 80) +
      ((node.validatorPrompt ?? '').length > 80 ? '…' : '')
    : '';

  const KindIcon = isFanOut ? GitFork : isValidator ? ShieldCheck : Bot;
  const accentClass = isFanOut
    ? 'border-violet-400/70 bg-violet-50/50 dark:bg-violet-950/30'
    : isValidator
      ? 'border-amber-400/70 bg-amber-50/50 dark:bg-amber-950/30'
      : 'border-sky-400/70 bg-sky-50/50 dark:bg-sky-950/30';
  const headerClass = isFanOut
    ? 'bg-violet-100/80 text-violet-900 dark:bg-violet-900/50 dark:text-violet-100'
    : isValidator
      ? 'bg-amber-100/80 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100'
      : 'bg-sky-100/80 text-sky-900 dark:bg-sky-900/50 dark:text-sky-100';

  return (
    <div
      className={cn(
        'rounded-lg border-2 shadow-sm w-[220px] text-xs overflow-hidden bg-background',
        accentClass,
        node.requires_confirmation && 'ring-2 ring-purple-400/60 ring-offset-1',
        props.selected && 'shadow-lg outline outline-2 outline-primary',
      )}
    >
      {/* Top input handle (always present) */}
      <Handle
        type="target"
        position={Position.Top}
        id="in"
        className="!h-2.5 !w-2.5 !bg-foreground"
      />

      {/* Header — kind badge + label */}
      <div
        className={cn(
          'flex items-center gap-1.5 px-2 py-1.5 border-b',
          headerClass,
        )}
      >
        <KindIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium truncate flex-1" title={node.label}>
          {node.label || <span className="opacity-50">(unnamed)</span>}
        </span>
        <span className="text-[9px] uppercase tracking-wider opacity-70">
          {isFanOut ? 'fan-out' : isValidator ? 'validator' : 'agent'}
        </span>
      </div>

      {/* Body */}
      <div className="px-2 py-1.5 space-y-1">
        {kind === 'agent' && (
          <Row
            icon={<GitBranch className="h-3 w-3 opacity-60" />}
            value={`@${node.role || 'unset'}`}
            mono
          />
        )}
        {isFanOut && (
          <Row
            icon={<GitFork className="h-3 w-3 opacity-60" />}
            value={
              node.fanOut?.mode === 'explicit'
                ? `${fanOutCount} branch${fanOutCount === 1 ? '' : 'es'}`
                : `each project · @${node.fanOut?.role || 'unset'}`
            }
            mono
          />
        )}
        {isValidator && validatorPromptPreview && (
          <div
            className="text-[10px] text-muted-foreground italic line-clamp-2"
            title={node.validatorPrompt ?? ''}
          >
            “{validatorPromptPreview}”
          </div>
        )}
        {hasOverride && (
          <Row
            icon={<Cpu className="h-3 w-3 opacity-60" />}
            value={
              [node.model_override?.provider, node.model_override?.model]
                .filter(Boolean)
                .join(' / ') || '(model override)'
            }
            mono
          />
        )}
        {branchMode !== 'linear' && (
          <Row
            icon={<CheckCheck className="h-3 w-3 opacity-60" />}
            value={branchMode}
          />
        )}
        {node.requires_confirmation && (
          <Row
            icon={<Hand className="h-3 w-3 text-purple-500" />}
            value="manual approval"
            tone="purple"
          />
        )}
        {node.validatorTools && node.validatorTools.length > 0 && (
          <Row
            icon={<AlertTriangle className="h-3 w-3 opacity-60" />}
            value={`${node.validatorTools.length} tool${node.validatorTools.length === 1 ? '' : 's'}`}
          />
        )}
      </div>

      {/* Output handles — three labelled outputs for any pass-fail
          routing (validators OR agent stages with regex pass-fail), one
          generic output for everything else. */}
      {!hasPassFailHandles && (
        <Handle
          type="source"
          position={Position.Bottom}
          id="out"
          className="!h-2.5 !w-2.5 !bg-foreground"
        />
      )}
      {hasPassFailHandles && (
        <>
          <Handle
            type="source"
            position={Position.Bottom}
            id="fail"
            style={{ left: '20%' }}
            className="!h-3 !w-3 !bg-rose-500 !border-rose-700"
            title="fail"
          />
          <Handle
            type="source"
            position={Position.Bottom}
            id="review"
            style={{ left: '50%' }}
            className="!h-3 !w-3 !bg-amber-400 !border-amber-600"
            title="review"
          />
          <Handle
            type="source"
            position={Position.Bottom}
            id="pass"
            style={{ left: '80%' }}
            className="!h-3 !w-3 !bg-emerald-500 !border-emerald-700"
            title="pass"
          />
          {/* Tiny labels under each handle so users know which is which. */}
          <div className="absolute -bottom-4 left-0 right-0 flex items-center text-[8px] uppercase tracking-wider text-muted-foreground pointer-events-none select-none">
            <span className="flex-1 text-center" style={{ paddingLeft: '8%' }}>
              fail
            </span>
            <span className="flex-1 text-center">review</span>
            <span className="flex-1 text-center" style={{ paddingRight: '8%' }}>
              pass
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function Row({
  icon,
  value,
  mono,
  tone,
}: {
  icon: React.ReactNode;
  value: string;
  mono?: boolean;
  tone?: 'purple';
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 text-[10px]',
        mono && 'font-mono',
        tone === 'purple' && 'text-purple-700 dark:text-purple-300',
      )}
    >
      {icon}
      <span className="truncate">{value}</span>
    </div>
  );
}
