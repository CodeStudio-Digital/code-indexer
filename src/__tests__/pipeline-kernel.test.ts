import { describe, it, expect } from 'vitest';
import {
  pickNextEdge,
  resolveBranchVerdictPure,
} from '@mcp/code-agent/pipelines/core/PipelineKernel.js';
import { validatePipelineGraph } from '@mcp/company/services/PipelineService.js';
import type { PipelineEdge, PipelineGraph } from '@mcp/company/types.js';

describe('pickNextEdge: review verdict', () => {
  it("routes 'review' to the matching pass-fail edge", () => {
    const edges: PipelineEdge[] = [
      { kind: 'pass-fail', id: 'p', from: 'v', on: 'pass', to: 'ok' },
      { kind: 'pass-fail', id: 'f', from: 'v', on: 'fail', to: 'retry' },
      { kind: 'pass-fail', id: 'r', from: 'v', on: 'review', to: 'human' },
    ];
    expect(pickNextEdge(edges, 'pass-fail', 'review')).toEqual({
      outcome: 'review',
      targetId: 'human',
    });
  });

  it("returns null when 'review' has no matching edge", () => {
    const edges: PipelineEdge[] = [
      { kind: 'pass-fail', id: 'p', from: 'v', on: 'pass', to: 'ok' },
      { kind: 'pass-fail', id: 'f', from: 'v', on: 'fail', to: 'retry' },
    ];
    expect(pickNextEdge(edges, 'pass-fail', 'review')).toBeNull();
  });
});

describe('resolveBranchVerdictPure', () => {
  it("returns null for linear nodes", () => {
    const v = resolveBranchVerdictPure({ mode: 'linear', output: 'whatever' });
    expect(v).toBeNull();
  });

  it("prefers verdictTokenResolver over qaResolver and regex", () => {
    const v = resolveBranchVerdictPure({
      mode: 'pass-fail',
      output: 'something PASS',
      qaResolver: () => 'fail',
      verdictTokenResolver: () => 'review',
    });
    expect(v).toBe('review');
  });

  it("falls back to qaResolver when no token verdict is present", () => {
    const v = resolveBranchVerdictPure({
      mode: 'pass-fail',
      output: 'no verdict here',
      qaResolver: () => 'pass',
    });
    expect(v).toBe('pass');
  });

  it("scans output for PASS/FAIL/REVIEW tokens as last resort", () => {
    expect(resolveBranchVerdictPure({ mode: 'pass-fail', output: 'all PASS' })).toBe('pass');
    expect(resolveBranchVerdictPure({ mode: 'pass-fail', output: 'huge FAIL today' })).toBe('fail');
    expect(resolveBranchVerdictPure({ mode: 'pass-fail', output: 'sent to REVIEW' })).toBe('review');
    expect(resolveBranchVerdictPure({ mode: 'pass-fail', output: 'inconclusive' })).toBeNull();
  });

  it("by-tag uses tagResolver", () => {
    expect(
      resolveBranchVerdictPure({
        mode: 'by-tag',
        output: '',
        tagResolver: () => 'bug',
      }),
    ).toBe('bug');
    expect(
      resolveBranchVerdictPure({ mode: 'by-tag', output: '' }),
    ).toBeNull();
  });

  it("by-text-match returns the raw output verbatim", () => {
    expect(resolveBranchVerdictPure({ mode: 'by-text-match', output: 'ALL GOOD' })).toBe('ALL GOOD');
  });
});

describe('validatePipelineGraph: validator rules', () => {
  it('rejects validator nodes with branchMode != pass-fail', () => {
    const graph: PipelineGraph = {
      version: 1,
      startNodeId: 'a',
      nodes: [
        { id: 'a', label: 'a', role: 'r', taskTemplate: 't' },
        {
          id: 'v',
          label: 'v',
          role: 'r',
          taskTemplate: '{{previous_output}}',
          kind: 'validate',
          validatorPrompt: 'Is the output good?',
          branchMode: 'linear',
        },
      ],
      edges: [{ kind: 'linear', id: 'e1', from: 'a', to: 'v' }],
    };
    const r = validatePipelineGraph(graph, null);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /must use branchMode='pass-fail'/.test(e.message))).toBe(true);
  });

  it('rejects validator nodes without validatorPrompt', () => {
    const graph: PipelineGraph = {
      version: 1,
      startNodeId: 'a',
      nodes: [
        { id: 'a', label: 'a', role: 'r', taskTemplate: 't' },
        {
          id: 'v',
          label: 'v',
          role: 'r',
          taskTemplate: '{{previous_output}}',
          kind: 'validate',
          branchMode: 'pass-fail',
        },
      ],
      edges: [
        { kind: 'linear', id: 'e1', from: 'a', to: 'v' },
        { kind: 'pass-fail', id: 'p', from: 'v', on: 'pass', to: 'a' },
      ],
    };
    const r = validatePipelineGraph(graph, null);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /requires a non-empty validatorPrompt/.test(e.message))).toBe(true);
  });

  it("rejects 'review' edges originating from non-validator nodes", () => {
    const graph: PipelineGraph = {
      version: 1,
      startNodeId: 'a',
      nodes: [
        { id: 'a', label: 'a', role: 'r', taskTemplate: 't' },
        { id: 'b', label: 'b', role: 'r', taskTemplate: 't' },
      ],
      edges: [
        { kind: 'pass-fail', id: 'r', from: 'a', on: 'review', to: 'b' },
      ],
    };
    const r = validatePipelineGraph(graph, null);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /on='review' must originate from a validator node/.test(e.message))).toBe(true);
  });

  it("accepts a well-formed validator with pass/fail/review edges", () => {
    const graph: PipelineGraph = {
      version: 1,
      startNodeId: 'a',
      nodes: [
        { id: 'a', label: 'a', role: 'r', taskTemplate: 't' },
        {
          id: 'v',
          label: 'v',
          role: 'r',
          taskTemplate: '{{previous_output}}',
          kind: 'validate',
          branchMode: 'pass-fail',
          validatorPrompt: 'Pass when output mentions tests; fail otherwise; review on doubt.',
        },
        { id: 'ok', label: 'ok', role: 'r', taskTemplate: 't' },
        { id: 'human', label: 'human', role: 'r', taskTemplate: 't' },
      ],
      edges: [
        { kind: 'linear', id: 'e1', from: 'a', to: 'v' },
        { kind: 'pass-fail', id: 'ep', from: 'v', on: 'pass', to: 'ok' },
        { kind: 'pass-fail', id: 'ef', from: 'v', on: 'fail', to: 'a' },
        { kind: 'pass-fail', id: 'er', from: 'v', on: 'review', to: 'human' },
      ],
    };
    const r = validatePipelineGraph(graph, null);
    expect(r.ok).toBe(true);
  });

  it("rejects more than one 'review' edge from the same validator", () => {
    const graph: PipelineGraph = {
      version: 1,
      startNodeId: 'a',
      nodes: [
        { id: 'a', label: 'a', role: 'r', taskTemplate: 't' },
        {
          id: 'v',
          label: 'v',
          role: 'r',
          taskTemplate: '{{previous_output}}',
          kind: 'validate',
          branchMode: 'pass-fail',
          validatorPrompt: 'criteria',
        },
        { id: 'h1', label: 'h1', role: 'r', taskTemplate: 't' },
        { id: 'h2', label: 'h2', role: 'r', taskTemplate: 't' },
      ],
      edges: [
        { kind: 'linear', id: 'e1', from: 'a', to: 'v' },
        { kind: 'pass-fail', id: 'r1', from: 'v', on: 'review', to: 'h1' },
        { kind: 'pass-fail', id: 'r2', from: 'v', on: 'review', to: 'h2' },
      ],
    };
    const r = validatePipelineGraph(graph, null);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /more than one 'review' branch/.test(e.message))).toBe(true);
  });
});
