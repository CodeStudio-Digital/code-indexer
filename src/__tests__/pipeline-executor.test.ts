import { describe, it, expect } from 'vitest';
import { pickNextEdge } from '../core/coder/company/services/PipelineExecutor.js';
import { validatePipelineGraph } from '../core/coder/company/services/PipelineService.js';
import type { PipelineEdge, PipelineGraph } from '../core/coder/company/types.js';

describe('pickNextEdge', () => {
  it('linear: returns the unique linear edge', () => {
    const edges: PipelineEdge[] = [{ kind: 'linear', id: 'e', from: 'a', to: 'b' }];
    expect(pickNextEdge(edges, 'linear', null)).toEqual({ outcome: 'linear', targetId: 'b' });
  });

  it('linear: returns null when there is no linear edge', () => {
    const edges: PipelineEdge[] = [
      { kind: 'pass-fail', id: 'e', from: 'a', on: 'pass', to: 'b' },
    ];
    expect(pickNextEdge(edges, 'linear', null)).toBeNull();
  });

  it('pass-fail: routes pass and fail to the right targets', () => {
    const edges: PipelineEdge[] = [
      { kind: 'pass-fail', id: 'p', from: 'qa', on: 'pass', to: 'done' },
      { kind: 'pass-fail', id: 'f', from: 'qa', on: 'fail', to: 'backend' },
    ];
    expect(pickNextEdge(edges, 'pass-fail', 'pass')).toEqual({
      outcome: 'pass',
      targetId: 'done',
    });
    expect(pickNextEdge(edges, 'pass-fail', 'fail')).toEqual({
      outcome: 'fail',
      targetId: 'backend',
    });
  });

  it('pass-fail: returns null when verdict is not pass or fail', () => {
    const edges: PipelineEdge[] = [
      { kind: 'pass-fail', id: 'p', from: 'qa', on: 'pass', to: 'done' },
      { kind: 'pass-fail', id: 'f', from: 'qa', on: 'fail', to: 'backend' },
    ];
    expect(pickNextEdge(edges, 'pass-fail', 'whatever')).toBeNull();
    expect(pickNextEdge(edges, 'pass-fail', null)).toBeNull();
  });

  it('by-tag: matches the tag exactly', () => {
    const edges: PipelineEdge[] = [
      { kind: 'by-tag', id: 't1', from: 'sort', tag: 'bug', to: 'fix' },
      { kind: 'by-tag', id: 't2', from: 'sort', tag: 'feature', to: 'plan' },
    ];
    expect(pickNextEdge(edges, 'by-tag', 'bug')).toEqual({ outcome: 'bug', targetId: 'fix' });
    expect(pickNextEdge(edges, 'by-tag', 'feature')).toEqual({
      outcome: 'feature',
      targetId: 'plan',
    });
    expect(pickNextEdge(edges, 'by-tag', 'refactor')).toBeNull();
  });

  it('by-text-match: first matching pattern wins', () => {
    const edges: PipelineEdge[] = [
      { kind: 'by-text-match', id: 'm1', from: 'a', pattern: '^OK$', to: 'done' },
      { kind: 'by-text-match', id: 'm2', from: 'a', pattern: 'ERROR', to: 'retry' },
    ];
    expect(pickNextEdge(edges, 'by-text-match', 'OK')).toEqual({
      outcome: '^OK$',
      targetId: 'done',
    });
    expect(pickNextEdge(edges, 'by-text-match', 'something ERROR happened')).toEqual({
      outcome: 'ERROR',
      targetId: 'retry',
    });
    expect(pickNextEdge(edges, 'by-text-match', 'huh?')).toBeNull();
  });

  it('by-text-match: ignores edges with bad regex and tries the next', () => {
    const edges: PipelineEdge[] = [
      { kind: 'by-text-match', id: 'broken', from: 'a', pattern: '[invalid', to: 'oops' },
      { kind: 'by-text-match', id: 'ok', from: 'a', pattern: 'ALL.*GOOD', to: 'done' },
    ];
    expect(pickNextEdge(edges, 'by-text-match', 'ALL VERY GOOD')).toEqual({
      outcome: 'ALL.*GOOD',
      targetId: 'done',
    });
  });
});

describe('validatePipelineGraph: cycle policy', () => {
  it('allows a cycle when the back-edge is a pass-fail fail', () => {
    const graph: PipelineGraph = {
      version: 1,
      startNodeId: 'plan',
      nodes: [
        { id: 'plan', label: 'p', role: 'r', taskTemplate: 't' },
        { id: 'qa', label: 'q', role: 'r', taskTemplate: 't' },
      ],
      edges: [
        { kind: 'linear', id: 'e1', from: 'plan', to: 'qa' },
        { kind: 'pass-fail', id: 'e2', from: 'qa', on: 'fail', to: 'plan' },
      ],
    };
    const r = validatePipelineGraph(graph, null);
    expect(r.ok).toBe(true);
  });

  it('allows a cycle reached via by-tag conditional edge', () => {
    const graph: PipelineGraph = {
      version: 1,
      startNodeId: 'a',
      nodes: [
        { id: 'a', label: 'a', role: 'r', taskTemplate: 't' },
        { id: 'b', label: 'b', role: 'r', taskTemplate: 't' },
      ],
      edges: [
        { kind: 'linear', id: 'e1', from: 'a', to: 'b' },
        { kind: 'by-tag', id: 'e2', from: 'b', tag: 'bug', to: 'a' },
      ],
    };
    const r = validatePipelineGraph(graph, null);
    expect(r.ok).toBe(true);
  });

  it('rejects a cycle made of only linear edges', () => {
    const graph: PipelineGraph = {
      version: 1,
      startNodeId: 'a',
      nodes: [
        { id: 'a', label: 'a', role: 'r', taskTemplate: 't' },
        { id: 'b', label: 'b', role: 'r', taskTemplate: 't' },
      ],
      edges: [
        { kind: 'linear', id: 'e1', from: 'a', to: 'b' },
        { kind: 'linear', id: 'e2', from: 'b', to: 'a' },
      ],
    };
    const r = validatePipelineGraph(graph, null);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /Forbidden cycle/.test(e.message))).toBe(true);
  });
});
