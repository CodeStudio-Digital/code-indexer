import type { Commit } from './commit-types.js';

const LANE_COLORS = [
  '#8b5cf6',
  '#22c55e',
  '#3b82f6',
  '#f59e0b',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
  '#f97316',
] as const;

interface Lane {
  target: string;
  color: number;
}

export interface GitGraphEdge {
  fromLane: number;
  toLane: number;
  color: number;
}

export interface GitGraphParentEdge {
  toLane: number;
  color: number;
}

export interface GitGraphRow {
  nodeLane: number;
  nodeColor: number;
  incoming: boolean;
  continuations: GitGraphEdge[];
  parents: GitGraphParentEdge[];
}

interface GitGraphLayout {
  rows: GitGraphRow[];
  maxLanes: number;
}

/**
 * Turns Git's topological order + parent SHAs into stable colored lanes.
 * First parents inherit the current lane; merge parents receive their own
 * color until their ancestry joins another lane. The calculation is O(rows ×
 * visible lanes), bounded by the paginated page size and independent of DOM.
 */
export function buildGitGraph(commits: readonly Commit[]): GitGraphLayout {
  let lanes: Lane[] = [];
  let nextColor = 0;
  let maxLanes = 1;
  const rows: GitGraphRow[] = [];

  for (const commit of commits) {
    const before = lanes.map((lane) => ({ ...lane }));
    let nodeLane = before.findIndex((lane) => lane.target === commit.sha);
    const incoming = nodeLane >= 0;

    if (nodeLane < 0) {
      nodeLane = before.length;
      before.push({ target: commit.sha, color: nextColor++ });
    }

    const nodeColor = before[nodeLane]?.color ?? 0;
    const after = before.filter((_, index) => index !== nodeLane);
    const parents = [...new Set(commit.parents ?? [])].filter(Boolean);

    parents.forEach((parent, parentIndex) => {
      if (after.some((lane) => lane.target === parent)) return;
      const color = parentIndex === 0 ? nodeColor : nextColor++;
      const insertAt = Math.min(nodeLane + parentIndex, after.length);
      after.splice(insertAt, 0, { target: parent, color });
    });

    const continuations = before
      .map((lane, fromLane): GitGraphEdge | null => {
        if (fromLane === nodeLane) return null;
        const toLane = after.findIndex((next) => next.target === lane.target);
        return toLane < 0 ? null : { fromLane, toLane, color: lane.color };
      })
      .filter((edge): edge is GitGraphEdge => edge !== null);

    const parentEdges = parents
      .map((parent): GitGraphParentEdge | null => {
        const toLane = after.findIndex((lane) => lane.target === parent);
        const target = after[toLane];
        return toLane < 0 || !target ? null : { toLane, color: target.color };
      })
      .filter((edge): edge is GitGraphParentEdge => edge !== null);

    maxLanes = Math.max(maxLanes, before.length, after.length);
    rows.push({ nodeLane, nodeColor, incoming, continuations, parents: parentEdges });
    lanes = after;
  }

  return { rows, maxLanes };
}

function gitGraphWidth(maxLanes: number): number {
  return Math.max(28, Math.min(126, 14 + Math.max(1, maxLanes) * 14));
}

function laneColor(index: number): string {
  return LANE_COLORS[index % LANE_COLORS.length] ?? LANE_COLORS[0];
}

export function GitGraphCell({
  row,
  maxLanes,
  selected,
}: {
  row: GitGraphRow;
  maxLanes: number;
  selected?: boolean;
}) {
  const width = gitGraphWidth(maxLanes);
  const height = 32;
  const middle = height / 2;
  const usableWidth = width - 14;
  const spacing = maxLanes <= 1 ? 0 : usableWidth / Math.max(1, maxLanes - 1);
  const x = (lane: number) => 7 + lane * spacing;
  const nodeX = x(row.nodeLane);

  return (
    <span
      className="self-stretch shrink-0 overflow-hidden"
      style={{ width }}
      aria-hidden="true"
      data-git-graph-lanes={maxLanes}
    >
      <svg width={width} height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {row.continuations.map((edge, index) => {
          const fromX = x(edge.fromLane);
          const toX = x(edge.toLane);
          return (
            <path
              key={`continuation-${index}`}
              d={`M ${fromX} 0 C ${fromX} ${middle - 4}, ${toX} ${middle + 4}, ${toX} ${height}`}
              fill="none"
              stroke={laneColor(edge.color)}
              strokeWidth="1.35"
              vectorEffect="non-scaling-stroke"
              opacity="0.86"
            />
          );
        })}

        {row.incoming && (
          <path
            d={`M ${nodeX} 0 L ${nodeX} ${middle}`}
            fill="none"
            stroke={laneColor(row.nodeColor)}
            strokeWidth="1.55"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {row.parents.map((edge, index) => {
          const toX = x(edge.toLane);
          return (
            <path
              key={`parent-${index}`}
              d={`M ${nodeX} ${middle} C ${nodeX} ${middle + 6}, ${toX} ${height - 6}, ${toX} ${height}`}
              fill="none"
              stroke={laneColor(edge.color)}
              strokeWidth="1.55"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        <circle
          cx={nodeX}
          cy={middle}
          r={selected ? 4.6 : 3.8}
          fill={laneColor(row.nodeColor)}
          stroke={selected ? 'hsl(var(--foreground))' : 'hsl(var(--background))'}
          strokeWidth={selected ? 1.5 : 1.15}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </span>
  );
}
