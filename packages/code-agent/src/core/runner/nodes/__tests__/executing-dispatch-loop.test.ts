import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { DupCallEntry } from '../../machine/types.js';
import { NoProgressTracker } from '../../guards/no-progress.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import { dispatchTools, type DispatchArgs } from '../executing-dispatch.js';

const toolContext = { cwd: process.cwd(), projectName: 'test' } as ToolContext;

function registryWith(tool: Partial<CoderTool> & { name: string }, invoked: () => void): ToolRegistry {
  const registry = new ToolRegistry();
  const { name, ...metadata } = tool;
  registry.register({
    ...metadata,
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: { x: { type: 'number' } } },
    source: 'native',
    handler: async () => {
      invoked();
      return { content: 'ok' };
    },
  } as CoderTool);
  return registry;
}

function batch(
  registry: ToolRegistry,
  name: string,
  inputs: Array<Record<string, unknown>>,
  turn: number,
): DispatchArgs {
  return {
    toolUses: inputs.map((input, i) => ({ id: `t${turn}-${i}`, name, input })),
    registry,
    toolContext,
    turn,
    dupCalls: new Map<string, DupCallEntry>(),
  };
}

describe('dispatchTools — local repeat protection', () => {
  it('coalesces stable read calls only inside each batch and never cross-turn-refuses', async () => {
    let invoked = 0;
    const registry = registryWith({
      name: 'read_file',
      mutates: false,
      executionClass: 'read',
      repeatPolicy: 'stable',
    }, () => { invoked++; });

    const first = await dispatchTools(batch(registry, 'read_file', [{ x: 1 }, { x: 1 }, { x: 1 }], 1));
    const second = await dispatchTools(batch(registry, 'read_file', [{ x: 1 }, { x: 1 }, { x: 1 }], 2));

    expect(invoked).toBe(2);
    expect(first.toolLoopDetected).toBe(false);
    expect(second.toolLoopDetected).toBe(false);
    expect(first.results.map((r) => r.guardVerdict?.action)).toEqual([undefined, 'reuse', 'reuse']);
    expect(first.results.map((r) => r.guardVerdict?.count)).toEqual([undefined, 2, 3]);
    expect(second.results.every((r) => !r.isError)).toBe(true);
  });

  it('warns then blocks the third identical mutation in one batch', async () => {
    let invoked = 0;
    const registry = registryWith({
      name: 'write_file',
      mutates: true,
      executionClass: 'write',
      repeatPolicy: 'mutating',
    }, () => { invoked++; });

    const result = await dispatchTools(batch(registry, 'write_file', [{ x: 1 }, { x: 1 }, { x: 1 }], 1));
    expect(invoked).toBe(2);
    expect(result.results[1].guardVerdict).toMatchObject({ action: 'warn', count: 2 });
    expect(result.results[2]).toMatchObject({ isError: true, refusalKind: 'dedup' });
    expect(result.toolLoopDetected).toBe(true);
    expect(result.loopDetail).toEqual({ toolName: 'write_file', count: 3 });
  });

  it('does not retain a hard-refusal counter across dispatch batches', async () => {
    let invoked = 0;
    const registry = registryWith({
      name: 'write_file',
      mutates: true,
      executionClass: 'write',
      repeatPolicy: 'mutating',
    }, () => { invoked++; });

    const first = await dispatchTools(batch(registry, 'write_file', [{ x: 1 }, { x: 1 }, { x: 1 }], 1));
    const next = await dispatchTools(batch(registry, 'write_file', [{ x: 1 }], 2));
    expect(first.toolLoopDetected).toBe(true);
    expect(next.toolLoopDetected).toBe(false);
    expect(next.results[0].isError).toBe(false);
  });

  it('executes volatile calls and emits only a post-result shadow candidate', async () => {
    let invoked = 0;
    const registry = registryWith({
      name: 'lsp_diagnostics',
      mutates: false,
      executionClass: 'read',
      repeatPolicy: 'volatile',
    }, () => { invoked++; });
    const noProgressTracker = new NoProgressTracker();
    const ledger = new ToolCallLedger();
    const context = { ...toolContext, toolCallLedger: ledger } as ToolContext;

    const run = (turn: number) => dispatchTools({
      ...batch(registry, 'lsp_diagnostics', [{ x: 1 }], turn),
      toolContext: context,
      noProgressTracker,
    });
    expect((await run(1)).results[0].guardVerdict).toBeUndefined();
    expect((await run(2)).results[0].guardVerdict).toBeUndefined();
    expect((await run(3)).results[0].guardVerdict).toMatchObject({
      action: 'shadow',
      reason: 'cross-turn-no-progress',
      wouldBlock: true,
    });
    expect(invoked).toBe(3);
  });

  it('actively breaks repeated unchanged control-plane snapshots when the tool opts in', async () => {
    let invoked = 0;
    const registry = registryWith({
      name: 'app_get_workflow',
      mutates: false,
      executionClass: 'read',
      repeatPolicy: 'volatile',
      stopOnRepeatedUnchangedResult: true,
    }, () => { invoked++; });
    const noProgressTracker = new NoProgressTracker();
    const context = { ...toolContext, toolCallLedger: new ToolCallLedger() } as ToolContext;
    const run = (turn: number) => dispatchTools({
      ...batch(registry, 'app_get_workflow', [{ x: 1 }], turn),
      toolContext: context,
      noProgressTracker,
    });

    expect((await run(1)).toolLoopDetected).toBe(false);
    expect((await run(2)).toolLoopDetected).toBe(false);
    const third = await run(3);
    expect(third.results[0].guardVerdict).toMatchObject({
      action: 'block',
      reason: 'cross-turn-no-progress-blocked',
      wouldBlock: true,
    });
    expect(third).toMatchObject({
      toolLoopDetected: true,
      loopGuard: 'doom-loop',
      loopDetail: { toolName: 'app_get_workflow', count: 3 },
    });
    expect(third.results[0].isError).toBe(false);
    expect(invoked).toBe(3);
  });

  it('force_reread bypasses same-batch stable result reuse', async () => {
    let invoked = 0;
    const registry = registryWith({
      name: 'read_file',
      mutates: false,
      executionClass: 'read',
      repeatPolicy: 'stable',
    }, () => { invoked++; });
    const result = await dispatchTools(batch(registry, 'read_file', [
      { x: 1, force_reread: true },
      { x: 1, force_reread: true },
      { x: 1, force_reread: true },
    ], 1));
    expect(invoked).toBe(3);
    expect(result.results.every((r) => !r.isError && r.guardVerdict?.action !== 'reuse')).toBe(true);
  });

  it('a successful write invalidates stable read reuse in the same batch', async () => {
    let reads = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_file',
      description: 'read',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      source: 'native',
      mutates: false,
      executionClass: 'read',
      repeatPolicy: 'stable',
      handler: async () => ({ content: `read-${++reads}` }),
    });
    registry.register({
      name: 'write_file',
      description: 'write',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      source: 'native',
      mutates: true,
      executionClass: 'write',
      repeatPolicy: 'mutating',
      handler: async () => ({ content: 'written' }),
    });
    const result = await dispatchTools({
      registry,
      toolContext,
      turn: 1,
      dupCalls: new Map(),
      toolUses: [
        { id: 'r1', name: 'read_file', input: { path: 'a.ts' } },
        { id: 'w1', name: 'write_file', input: { path: 'a.ts' } },
        { id: 'r2', name: 'read_file', input: { path: 'a.ts' } },
      ],
    });
    expect(reads).toBe(2);
    expect(result.results[2].guardVerdict?.action).not.toBe('reuse');
    expect(result.results[2].stateEpoch).toBe(1);
  });

  it('normalizes aliases and defaults before same-batch reuse', async () => {
    let invoked = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_file',
      description: 'read',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          encoding: { type: 'string', default: 'utf8' },
        },
      },
      source: 'native',
      mutates: false,
      executionClass: 'read',
      repeatPolicy: 'stable',
      handler: async () => { invoked++; return { content: 'ok' }; },
    });
    const noProgressTracker = new NoProgressTracker();
    const context = { ...toolContext, toolCallLedger: new ToolCallLedger() } as ToolContext;
    const result = await dispatchTools({
      registry,
      toolContext: context,
      turn: 1,
      dupCalls: new Map(),
      noProgressTracker,
      toolUses: [
        { id: 'r1', name: 'read_file', input: { file_path: 'a.ts' } },
        { id: 'r2', name: 'read_file', input: { path: 'a.ts', encoding: 'utf8' } },
      ],
    });
    expect(invoked).toBe(1);
    expect(result.results[1].guardVerdict).toMatchObject({ action: 'reuse' });

    const runLater = (turn: number, input: Record<string, unknown>) => dispatchTools({
      registry,
      toolContext: context,
      turn,
      dupCalls: new Map(),
      noProgressTracker,
      toolUses: [{ id: `r${turn + 1}`, name: 'read_file', input }],
    });
    expect((await runLater(2, { file_path: 'a.ts' })).results[0].guardVerdict).toBeUndefined();
    expect((await runLater(3, { path: 'a.ts', encoding: 'utf8' })).results[0].guardVerdict)
      .toMatchObject({ action: 'shadow', reason: 'cross-turn-no-progress' });
    expect(invoked).toBe(3);
  });
});
