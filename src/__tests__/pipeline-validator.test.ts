import { describe, it, expect } from 'vitest';
import {
  validatePipelineGraph,
  resolveStartNode,
  renderNodeTask,
} from '../core/coder/company/services/PipelineService.js';
import type { PipelineGraph } from '../core/coder/company/types.js';

const baseNode = (id: string, role = 'backend') => ({
  id,
  label: id,
  role,
  taskTemplate: 'do {{initial_input}}',
});

describe('validatePipelineGraph', () => {
  it('accepts a single-node graph', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [baseNode('a')],
      edges: [],
    };
    const result = validatePipelineGraph(graph, new Set(['backend']));
    expect(result.ok).toBe(true);
  });

  it('accepts a linear chain', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [baseNode('a'), baseNode('b'), baseNode('c')],
      edges: [
        { kind: 'linear', id: 'e1', from: 'a', to: 'b' },
        { kind: 'linear', id: 'e2', from: 'b', to: 'c' },
      ],
    };
    expect(validatePipelineGraph(graph, new Set(['backend'])).ok).toBe(true);
  });

  it('rejects unknown role when validRoles is provided', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [baseNode('a', 'wizard')],
      edges: [],
    };
    const result = validatePipelineGraph(graph, new Set(['backend']));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /unknown role "wizard"/i.test(e.message))).toBe(true);
  });

  it('skips role check when validRoles is null', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [baseNode('a', 'whatever')],
      edges: [],
    };
    expect(validatePipelineGraph(graph, null).ok).toBe(true);
  });

  it('rejects duplicate node ids', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [baseNode('a'), baseNode('a')],
      edges: [],
    };
    const result = validatePipelineGraph(graph, null);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /Duplicate node id/.test(e.message))).toBe(true);
  });

  it('rejects edges to/from missing nodes', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [baseNode('a')],
      edges: [{ kind: 'linear', id: 'e1', from: 'a', to: 'ghost' }],
    };
    const result = validatePipelineGraph(graph, null);
    expect(result.ok).toBe(false);
  });

  it('rejects multiple roots without explicit startNodeId', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [baseNode('a'), baseNode('b')],
      edges: [],
    };
    const result = validatePipelineGraph(graph, null);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /Multiple root nodes/.test(e.message))).toBe(true);
  });

  it('accepts forbidden cycle only when reached via pass-fail fail edge', () => {
    // Cycle a→b→a via a linear edge — forbidden in V0.
    const linearLoop: PipelineGraph = {
      version: 1,
      startNodeId: 'a',
      nodes: [baseNode('a'), baseNode('b')],
      edges: [
        { kind: 'linear', id: 'e1', from: 'a', to: 'b' },
        { kind: 'linear', id: 'e2', from: 'b', to: 'a' },
      ],
    };
    const result1 = validatePipelineGraph(linearLoop, null);
    expect(result1.ok).toBe(false);
    expect(result1.errors.some((e) => /Forbidden cycle/.test(e.message))).toBe(true);

    // Same cycle but the back-edge is pass-fail on='fail' — V1 territory, allowed.
    const guardedLoop: PipelineGraph = {
      version: 1,
      startNodeId: 'a',
      nodes: [baseNode('a'), baseNode('b')],
      edges: [
        { kind: 'linear', id: 'e1', from: 'a', to: 'b' },
        { kind: 'pass-fail', id: 'e2', from: 'b', on: 'fail', to: 'a' },
      ],
    };
    const result2 = validatePipelineGraph(guardedLoop, null);
    expect(result2.ok).toBe(true);
  });

  it('rejects more than one pass branch from the same node', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [baseNode('a'), baseNode('b'), baseNode('c')],
      edges: [
        { kind: 'pass-fail', id: 'e1', from: 'a', on: 'pass', to: 'b' },
        { kind: 'pass-fail', id: 'e2', from: 'a', on: 'pass', to: 'c' },
      ],
    };
    const result = validatePipelineGraph(graph, null);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /more than one 'pass' branch/.test(e.message))).toBe(true);
  });
});

describe('resolveStartNode', () => {
  it('returns the unique root', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [baseNode('a'), baseNode('b')],
      edges: [{ kind: 'linear', id: 'e1', from: 'a', to: 'b' }],
    };
    expect(resolveStartNode(graph)?.id).toBe('a');
  });

  it('honours explicit startNodeId', () => {
    const graph: PipelineGraph = {
      version: 1,
      startNodeId: 'b',
      nodes: [baseNode('a'), baseNode('b')],
      edges: [{ kind: 'linear', id: 'e1', from: 'a', to: 'b' }],
    };
    expect(resolveStartNode(graph)?.id).toBe('b');
  });

  it('returns null when the graph has multiple roots', () => {
    const graph: PipelineGraph = {
      version: 1,
      nodes: [baseNode('a'), baseNode('b')],
      edges: [],
    };
    expect(resolveStartNode(graph)).toBeNull();
  });
});

describe('renderNodeTask', () => {
  it('substitutes initial_input and previous_output', () => {
    const out = renderNodeTask({
      template: 'work on {{initial_input}}; previous: {{previous_output}}',
      initialInput: 'feature X',
      previousOutput: 'plan ready',
      vars: {},
    });
    expect(out).toBe('work on feature X; previous: plan ready');
  });

  it('substitutes vars by node id', () => {
    const out = renderNodeTask({
      template: '{{vars.investigate.output}}',
      initialInput: '',
      previousOutput: '',
      vars: { investigate: { output: 'findings' } },
    });
    expect(out).toBe('findings');
  });

  it('leaves unknown placeholders empty for vars and untouched for unrecognized braces', () => {
    const out = renderNodeTask({
      template: '{{vars.nope.output}} | {{ literal }}',
      initialInput: '',
      previousOutput: '',
      vars: {},
    });
    expect(out).toBe(' | {{ literal }}');
  });
});
