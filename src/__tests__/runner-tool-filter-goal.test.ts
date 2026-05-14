/**
 * Runner-level filter that hides `create_goal` from the tool surface
 * when a session already has an in_progress goal.
 *
 * Background — sessions 656/658 (production):
 *   The model — even with the user explicitly saying "ignore the GOAL" —
 *   kept emitting `create_goal` instead of doing the actual work. Earlier
 *   defenses (auto-supersede default, in-result "do not call again"
 *   nudge, per-runner burst cap) all kept the tool name visible in the
 *   model's context, which paradoxically reinforced the loop. Removing
 *   the tool from buildTools()'s output once a goal is in_progress is
 *   the structural fix — the model literally never sees `create_goal`
 *   again, so the loop is impossible by construction. update_goal
 *   flipping status='complete' on the next turn re-exposes create_goal,
 *   so legitimate pivots still work.
 *
 * The filter is exported as a pure function from runner.ts so we can
 * test it in isolation without spinning up a full CoderRunner.
 */
import { describe, it, expect } from 'vitest';
import { filterGoalToolsByState } from '../core/coder/core/runner.js';

interface MockTool {
  name: string;
  description: string;
}

const mockTools: MockTool[] = [
  { name: 'create_goal', description: 'set the goal' },
  { name: 'get_goal', description: 'read the goal' },
  { name: 'update_goal', description: 'mark complete' },
  { name: 'create_file', description: 'write a file' },
  { name: 'read_file', description: 'read a file' },
];

describe('filterGoalToolsByState', () => {
  it('returns the input unchanged when no goal state is provided', () => {
    const r = filterGoalToolsByState(mockTools, null);
    expect(r.map((t) => t.name)).toEqual([
      'create_goal',
      'get_goal',
      'update_goal',
      'create_file',
      'read_file',
    ]);
  });

  it('returns the input unchanged when goal state is undefined', () => {
    const r = filterGoalToolsByState(mockTools, undefined);
    expect(r.map((t) => t.name)).toContain('create_goal');
  });

  it('hides create_goal when the active goal is in_progress', () => {
    const r = filterGoalToolsByState(mockTools, { status: 'in_progress' });
    const names = r.map((t) => t.name);
    expect(names).not.toContain('create_goal');
    // get_goal and update_goal stay visible — agent must still re-read
    // the goal and mark it complete.
    expect(names).toContain('get_goal');
    expect(names).toContain('update_goal');
    // Unrelated tools are untouched.
    expect(names).toContain('create_file');
    expect(names).toContain('read_file');
  });

  it('re-exposes create_goal once the goal is marked complete', () => {
    const r = filterGoalToolsByState(mockTools, { status: 'complete' });
    const names = r.map((t) => t.name);
    expect(names).toContain('create_goal');
    // Sanity: the rest of the surface is also intact.
    expect(names).toContain('get_goal');
    expect(names).toContain('update_goal');
  });

  it('does not mutate the input array', () => {
    const before = mockTools.map((t) => t.name);
    filterGoalToolsByState(mockTools, { status: 'in_progress' });
    const after = mockTools.map((t) => t.name);
    expect(after).toEqual(before);
  });

  it('handles an empty tool list cleanly', () => {
    expect(filterGoalToolsByState([], { status: 'in_progress' })).toEqual([]);
    expect(filterGoalToolsByState([], null)).toEqual([]);
  });

  it('hides every create_goal entry if the registry happens to have duplicates', () => {
    // Defensive: the registry shouldn't have duplicates, but the filter
    // shouldn't depend on that — should remove them all.
    const dup = [...mockTools, { name: 'create_goal', description: 'duplicate' }];
    const r = filterGoalToolsByState(dup, { status: 'in_progress' });
    expect(r.filter((t) => t.name === 'create_goal')).toHaveLength(0);
  });
});
