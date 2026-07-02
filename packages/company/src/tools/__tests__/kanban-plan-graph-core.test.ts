/**
 * Tests for the pure kanban_plan_graph validation core (C4): local-id
 * uniqueness, dep resolution, self-deps, cycle detection (DFS), the 30-node
 * cap and the topological creation order (dependencies first).
 */
import { describe, expect, it } from 'vitest';
import {
  PLAN_GRAPH_MAX_NODES,
  validatePlanGraph,
  type PlanGraphNode,
} from '../kanban-plan-graph-core.js';

const node = (id: string, over: Partial<PlanGraphNode> = {}): PlanGraphNode => ({
  id,
  title: `Task ${id}`,
  ...over,
});

describe('validatePlanGraph — structural checks', () => {
  it('rejects an empty nodes array', () => {
    expect(validatePlanGraph([])).toMatchObject({ ok: false });
  });

  it('rejects more than the node cap', () => {
    const nodes = Array.from({ length: PLAN_GRAPH_MAX_NODES + 1 }, (_, i) => node(`n${i}`));
    const result = validatePlanGraph(nodes);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain(String(PLAN_GRAPH_MAX_NODES));
  });

  it('accepts exactly the cap', () => {
    const nodes = Array.from({ length: PLAN_GRAPH_MAX_NODES }, (_, i) => node(`n${i}`));
    expect(validatePlanGraph(nodes).ok).toBe(true);
  });

  it('rejects duplicate local ids', () => {
    const result = validatePlanGraph([node('a'), node('a')]);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('Duplicate');
  });

  it('rejects empty ids and empty titles', () => {
    expect(validatePlanGraph([node('  ')])).toMatchObject({ ok: false });
    expect(validatePlanGraph([node('a', { title: '' })])).toMatchObject({ ok: false });
  });

  it('rejects invalid tag and column values', () => {
    expect(
      validatePlanGraph([node('a', { tag: 'epic' as never })]),
    ).toMatchObject({ ok: false });
    expect(
      validatePlanGraph([node('a', { column: 'done' as never })]),
    ).toMatchObject({ ok: false });
  });
});

describe('validatePlanGraph — dependencies', () => {
  it('rejects a dep pointing at an unknown local id', () => {
    const result = validatePlanGraph([node('a', { depends_on: ['ghost'] })]);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('ghost');
  });

  it('rejects a self-dependency', () => {
    expect(
      validatePlanGraph([node('a', { depends_on: ['a'] })]),
    ).toMatchObject({ ok: false });
  });

  it('detects a 2-node cycle', () => {
    const result = validatePlanGraph([
      node('a', { depends_on: ['b'] }),
      node('b', { depends_on: ['a'] }),
    ]);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('cycle');
  });

  it('detects a longer cycle buried in a valid graph', () => {
    const result = validatePlanGraph([
      node('root'),
      node('a', { depends_on: ['root', 'c'] }),
      node('b', { depends_on: ['a'] }),
      node('c', { depends_on: ['b'] }),
    ]);
    expect(result).toMatchObject({ ok: false });
  });

  it('returns dependencies-first creation order for a diamond DAG', () => {
    const result = validatePlanGraph([
      node('top', { depends_on: ['left', 'right'] }),
      node('left', { depends_on: ['base'] }),
      node('right', { depends_on: ['base'] }),
      node('base'),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pos = new Map(result.order.map((id, i) => [id, i]));
    expect(result.order).toHaveLength(4);
    expect(pos.get('base')!).toBeLessThan(pos.get('left')!);
    expect(pos.get('base')!).toBeLessThan(pos.get('right')!);
    expect(pos.get('left')!).toBeLessThan(pos.get('top')!);
    expect(pos.get('right')!).toBeLessThan(pos.get('top')!);
  });

  it('handles disconnected components (every node appears once)', () => {
    const result = validatePlanGraph([
      node('a'),
      node('b', { depends_on: ['a'] }),
      node('x'),
      node('y', { depends_on: ['x'] }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.order].sort()).toEqual(['a', 'b', 'x', 'y']);
  });
});
