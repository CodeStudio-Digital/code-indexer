/**
 * git-revision bump: monotonic per-project revision + branch-change detection.
 * The first frame for a project (seed) must never count as a switch.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useGitRevision } from '../git-revision.js';

beforeEach(() => {
  useGitRevision.setState({ revByProject: {}, branchByProject: {} });
});

describe('useGitRevision.bump', () => {
  it('records a first frame without reporting a switch', () => {
    const { bump } = useGitRevision.getState();
    expect(bump(1, 'main')).toEqual({ branchChanged: false });
    expect(useGitRevision.getState().revByProject[1]).toBe(1);
  });

  it('does not report a switch when the branch is unchanged', () => {
    const { bump } = useGitRevision.getState();
    bump(1, 'main');
    expect(bump(1, 'main')).toEqual({ branchChanged: false });
    expect(useGitRevision.getState().revByProject[1]).toBe(2);
  });

  it('reports a switch when the branch name changes', () => {
    const { bump } = useGitRevision.getState();
    bump(1, 'main');
    expect(bump(1, 'develop')).toEqual({ branchChanged: true });
  });

  it('treats branch → detached (null) as a switch', () => {
    const { bump } = useGitRevision.getState();
    bump(1, 'main');
    expect(bump(1, null)).toEqual({ branchChanged: true });
  });

  it('keeps revisions independent per project', () => {
    const { bump } = useGitRevision.getState();
    bump(1, 'main');
    bump(2, 'main');
    bump(1, 'dev');
    expect(useGitRevision.getState().revByProject[1]).toBe(2);
    expect(useGitRevision.getState().revByProject[2]).toBe(1);
  });

  describe('seed frames (isSeed=true)', () => {
    it('records the branch WITHOUT bumping the revision (no redundant refetch on mount)', () => {
      const { bump } = useGitRevision.getState();
      expect(bump(1, 'main', true)).toEqual({ branchChanged: false });
      expect(useGitRevision.getState().revByProject[1] ?? 0).toBe(0);
      expect(useGitRevision.getState().branchByProject[1]).toBe('main');
    });

    it('a later real change off a seed is detected and bumps the revision once', () => {
      const { bump } = useGitRevision.getState();
      bump(1, 'main', true); // seed: rev stays 0, branch recorded
      expect(bump(1, 'develop')).toEqual({ branchChanged: true });
      expect(useGitRevision.getState().revByProject[1]).toBe(1);
    });

    it('a reconnect seed with the same branch does not bump (no churn)', () => {
      const { bump } = useGitRevision.getState();
      bump(1, 'main', true);
      bump(1, 'main', true); // reconnect seed, unchanged branch
      expect(useGitRevision.getState().revByProject[1] ?? 0).toBe(0);
    });

    it('a seed that reveals a switch missed while disconnected bumps + reports it', () => {
      const { bump } = useGitRevision.getState();
      bump(1, 'main', true);
      // Reconnect after the user switched during the drop — seed carries the new branch.
      expect(bump(1, 'develop', true)).toEqual({ branchChanged: true });
      expect(useGitRevision.getState().revByProject[1]).toBe(1);
    });
  });
});
