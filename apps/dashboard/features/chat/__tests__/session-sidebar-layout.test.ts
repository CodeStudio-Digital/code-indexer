import { describe, expect, it } from 'vitest';
import { isExecutingSessionStatus, sessionSidebarClassName } from '../SessionSidebar.js';
import { groupSessionBranches, visibleSessionBranches } from '../session-lineage.js';
import type { CoderSession } from '../types.js';

describe('session sidebar layout', () => {
  it('keeps a workbench-docked sidebar visible below the lg breakpoint', () => {
    const classes = sessionSidebarClassName(true, false);

    expect(classes).toContain('h-full');
    expect(classes).toContain('w-full');
    expect(classes).toContain('translate-x-0');
    expect(classes).not.toContain('-translate-x-full');
    expect(classes).not.toContain('fixed');
  });

  it('retains the off-canvas behavior for the standalone mobile drawer', () => {
    expect(sessionSidebarClassName(false, false)).toContain('-translate-x-full');
    expect(sessionSidebarClassName(false, true)).toContain('translate-x-0');
  });

  it('recognizes persisted live-run statuses without treating terminal sessions as active', () => {
    expect(isExecutingSessionStatus('running')).toBe(true);
    expect(isExecutingSessionStatus('in_progress')).toBe(true);
    expect(isExecutingSessionStatus('working')).toBe(true);
    expect(isExecutingSessionStatus('idle')).toBe(false);
    expect(isExecutingSessionStatus('error')).toBe(false);
  });

  it('nests existing children in order, shows orphans and respects explicit groups', () => {
    const sessions = [
      { id: 'grandchild', parent_session_id: 'child' },
      { id: 'moved', parent_session_id: 'child', group_id: 'review' },
      { id: 'orphan', parent_session_id: 'archived-parent' },
      { id: 'child', parent_session_id: 'parent' },
      { id: 'parent', group_id: 'work' },
    ] as CoderSession[];
    const { groups, parents } = groupSessionBranches(sessions, session => session.group_id ?? undefined, 'ungrouped');
    const work = groups.get('work')!;
    const visible = (collapsed: string[] = []) => visibleSessionBranches(work.roots, new Set(collapsed))
      .map(({ branch, depth }) => [branch.session.id, depth]);

    expect(work.count).toBe(3);
    expect(visible()).toEqual([['parent', 0], ['child', 1], ['grandchild', 2]]);
    expect(visible(['child'])).toEqual([['parent', 0], ['child', 1]]);
    expect(visible(['parent'])).toEqual([['parent', 0]]);
    expect(parents.get('grandchild')).toBe('child');
    expect(groups.get('review')?.roots[0].session.id).toBe('moved');
    expect(groups.get('ungrouped')?.roots[0].session.id).toBe('orphan');
  });

  it('keeps malformed cyclic ancestry reachable as a finite tree', () => {
    const sessions = [{ id: 'a', parent_session_id: 'b' }, { id: 'b', parent_session_id: 'a' }] as CoderSession[];
    const { groups } = groupSessionBranches(sessions, () => undefined, 'ungrouped');
    expect(visibleSessionBranches(groups.get('ungrouped')!.roots, new Set())
      .map(({ branch }) => branch.session.id)).toEqual(['b', 'a']);
  });
});
