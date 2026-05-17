/**
 * Custom React Flow edge renderer for pipeline transitions.
 *
 * Default labels are unstyled black text floating over the wire — fine
 * for a single edge, painful for a graph with conditional branches. This
 * component:
 *   - Renders a colored chip on the wire (green=pass, red=fail,
 *     amber=review, gray=linear, etc.)
 *   - Stays readable when the wire is steep or zigzags
 *
 * The discriminator is the `pipelineEdge` shape on `data` — we mirror
 * the union types from `company/types.ts`.
 */
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from '@xyflow/react';
import type { PipelineEdge } from '@mcp/company/types.js';
import { cn } from '../../../lib/utils.js';

export const PIPELINE_EDGE_TYPE = 'pipelineEdge' as const;

export interface PipelineEdgeData extends Record<string, unknown> {
  pipelineEdge: PipelineEdge;
}

export function PipelineEdgeView(props: EdgeProps & { data?: PipelineEdgeData }) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    selected,
    data,
  } = props;

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 8,
  });

  const meta = describeEdge(data?.pipelineEdge);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: selected ? meta.strokeSelected : meta.stroke,
          strokeWidth: selected ? 2.5 : 1.5,
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
          className={cn(
            'px-1.5 py-0.5 rounded text-[10px] font-medium border shadow-sm pointer-events-auto select-none',
            meta.bg,
            meta.text,
            meta.border,
          )}
        >
          {meta.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

interface EdgeMeta {
  label: string;
  stroke: string;
  strokeSelected: string;
  bg: string;
  text: string;
  border: string;
}

function describeEdge(edge: PipelineEdge | undefined): EdgeMeta {
  if (!edge) return GRAY;
  switch (edge.kind) {
    case 'linear':
      return { ...GRAY, label: '→' };
    case 'pass-fail':
      if (edge.on === 'pass') return PASS;
      if (edge.on === 'fail') return FAIL;
      return REVIEW;
    case 'by-tag':
      return { ...PURPLE, label: `tag: ${edge.tag}` };
    case 'by-text-match': {
      const trimmed = edge.pattern.length > 16
        ? `${edge.pattern.slice(0, 16)}…`
        : edge.pattern;
      return { ...PURPLE, label: `match: ${trimmed}` };
    }
  }
}

// Literal hex colors — the previous `hsl(var(--muted-foreground))` form
// resolves correctly in HTML inline styles but not always in SVG path
// `stroke` (some browsers / theme combinations skip the substitution),
// leaving the wire invisible. Hard-coding picks a value that reads on
// both light and dark backgrounds.
const GRAY: EdgeMeta = {
  label: '→',
  stroke: '#94a3b8', // slate-400
  strokeSelected: '#0ea5e9', // sky-500
  bg: 'bg-muted',
  text: 'text-muted-foreground',
  border: 'border-border',
};

const PASS: EdgeMeta = {
  label: '✓ pass',
  stroke: '#10b981', // emerald-500
  strokeSelected: '#047857', // emerald-700
  bg: 'bg-emerald-100 dark:bg-emerald-900/40',
  text: 'text-emerald-800 dark:text-emerald-200',
  border: 'border-emerald-400/60',
};

const FAIL: EdgeMeta = {
  label: '✗ fail',
  stroke: '#f43f5e', // rose-500
  strokeSelected: '#be123c', // rose-700
  bg: 'bg-rose-100 dark:bg-rose-900/40',
  text: 'text-rose-800 dark:text-rose-200',
  border: 'border-rose-400/60',
};

const REVIEW: EdgeMeta = {
  label: '? review',
  stroke: '#f59e0b', // amber-500
  strokeSelected: '#b45309', // amber-700
  bg: 'bg-amber-100 dark:bg-amber-900/40',
  text: 'text-amber-800 dark:text-amber-200',
  border: 'border-amber-400/60',
};

const PURPLE: EdgeMeta = {
  label: '',
  stroke: '#a855f7', // purple-500
  strokeSelected: '#7e22ce', // purple-700
  bg: 'bg-purple-100 dark:bg-purple-900/40',
  text: 'text-purple-800 dark:text-purple-200',
  border: 'border-purple-400/60',
};
