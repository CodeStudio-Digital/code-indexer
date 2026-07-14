import { describe, expect, it } from 'vitest';
import { buildGitGraph } from '../git-graph.js';
import type { Commit } from '../CommitRow.js';

function commit(sha: string, parents: string[] = []): Commit {
  return { sha, shortSha: sha, author: 'Tester', date: '2026-07-13T12:00:00Z', subject: sha, parents, refs: [] };
}

describe('buildGitGraph', () => {
  it('keeps a linear history on one stable lane', () => {
    const graph = buildGitGraph([
      commit('c', ['b']),
      commit('b', ['a']),
      commit('a'),
    ]);

    expect(graph.maxLanes).toBe(1);
    expect(graph.rows.map((row) => row.nodeLane)).toEqual([0, 0, 0]);
    expect(graph.rows.map((row) => row.nodeColor)).toEqual([0, 0, 0]);
  });

  it('creates a second lane for a merge parent and joins it later', () => {
    const graph = buildGitGraph([
      commit('merge', ['main-1', 'feature-1']),
      commit('main-1', ['base']),
      commit('feature-1', ['base']),
      commit('base'),
    ]);

    expect(graph.maxLanes).toBe(2);
    expect(graph.rows[0]?.parents.map((edge) => edge.toLane)).toEqual([0, 1]);
    expect(graph.rows[1]?.nodeLane).toBe(0);
    expect(graph.rows[2]?.nodeLane).toBe(1);
    expect(graph.rows[2]?.parents[0]?.toLane).toBe(0);
  });

  it('keeps unresolved parents open at a pagination boundary', () => {
    const graph = buildGitGraph([commit('tip', ['older'])]);

    expect(graph.maxLanes).toBe(1);
    expect(graph.rows[0]?.parents).toHaveLength(1);
    expect(graph.rows[0]?.parents[0]?.toLane).toBe(0);
  });
});
