/**
 * PermissionGate at the dispatch layer — a denial synthesizes an error
 * result WITHOUT invoking the handler (mirroring the toolGate refusal
 * shape), an approval proceeds normally, the dashboard block is created
 * BEFORE the gate consult (anchor for the approval card), and the pause
 * happens OUTSIDE the per-tool timeout window (user decision time can't
 * trip `[tool-timeout`).
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { PermissionGate } from '@mcp/code-agent/core/permission-gate.js';
import type { DupCallEntry } from '../../machine/types.js';
import { dispatchTools, type DispatchArgs } from '../executing-dispatch.js';

function registryWith(tool: Partial<CoderTool> & { name: string }, onInvoke?: () => void): ToolRegistry {
  const r = new ToolRegistry();
  r.register({
    description: `${tool.name} tool`,
    parameters: { type: 'object', properties: {} },
    source: 'native',
    handler: async () => {
      onInvoke?.();
      return { content: 'ok' };
    },
    ...tool,
  } as CoderTool);
  return r;
}

function fakeGate(check: PermissionGate['check']): PermissionGate {
  return { check, pendingCount: () => 0 } as unknown as PermissionGate;
}

function args(
  registry: ToolRegistry,
  gate: PermissionGate | undefined,
  extra?: Partial<DispatchArgs>,
): DispatchArgs {
  const toolContext = { cwd: process.cwd(), projectName: 'test', permissionGate: gate } as ToolContext;
  return {
    toolUses: [{ id: 'tu1', name: 'run_command', input: { command: 'ls' } }],
    registry,
    toolContext,
    turn: 1,
    dupCalls: new Map<string, DupCallEntry>(),
    ...extra,
  };
}

describe('dispatchTools — permission gate', () => {
  it('denial synthesizes an error result and never invokes the handler', async () => {
    let invoked = 0;
    const registry = registryWith({ name: 'run_command', riskLevel: 'execute' }, () => { invoked++; });
    const gate = fakeGate(async () => ({
      allowed: false,
      refusalText: '[user-denied: o usuário negou permissão para `run_command`.]',
    }));
    const result = await dispatchTools(args(registry, gate));
    expect(invoked).toBe(0);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      toolUseId: 'tu1',
      isError: true,
      durationMs: 0,
      wasRefusedByDedup: false,
    });
    expect(result.results[0].content.startsWith('[user-denied')).toBe(true);
    expect(result.toolLoopDetected).toBe(false);
  });

  it('approval proceeds to the handler', async () => {
    let invoked = 0;
    const registry = registryWith({ name: 'run_command', riskLevel: 'execute' }, () => { invoked++; });
    const gate = fakeGate(async () => ({ allowed: true }));
    const result = await dispatchTools(args(registry, gate));
    expect(invoked).toBe(1);
    expect(result.results[0].isError).toBeFalsy();
    expect(result.results[0].content).toBe('ok');
  });

  it('fires onToolCallStart BEFORE the gate consult (block = approval anchor)', async () => {
    const order: string[] = [];
    const registry = registryWith({ name: 'run_command', riskLevel: 'execute' });
    const gate = fakeGate(async (req) => {
      order.push(`gate:${req.toolUseId}`);
      return { allowed: true };
    });
    await dispatchTools(args(registry, gate, {
      onToolCallStart: (id) => { order.push(`start:${id}`); },
    }));
    expect(order).toEqual(['start:tu1', 'gate:tu1']);
  });

  it('a slow approval does not trip the per-tool timeout (clock starts post-gate)', async () => {
    const registry = registryWith({ name: 'run_command', riskLevel: 'execute', timeoutMs: 10 });
    const gate = fakeGate(async () => {
      await new Promise((r) => setTimeout(r, 50)); // user thinks for 5× the tool timeout
      return { allowed: true };
    });
    const result = await dispatchTools(args(registry, gate));
    expect(result.results[0].isError).toBeFalsy();
    expect(result.results[0].content).toBe('ok');
  });

  it('passes the tool object and turn to the gate', async () => {
    const registry = registryWith({ name: 'run_command', riskLevel: 'execute' });
    let seen: { toolName?: string; turn?: number; hasTool?: boolean } = {};
    const gate = fakeGate(async (req) => {
      seen = { toolName: req.toolName, turn: req.turn, hasTool: !!req.tool };
      return { allowed: true };
    });
    await dispatchTools(args(registry, gate, { turn: 7 }));
    expect(seen).toEqual({ toolName: 'run_command', turn: 7, hasTool: true });
  });

  it('no gate on the context → legacy behavior (everything runs)', async () => {
    let invoked = 0;
    const registry = registryWith({ name: 'run_command', riskLevel: 'execute' }, () => { invoked++; });
    const result = await dispatchTools(args(registry, undefined));
    expect(invoked).toBe(1);
    expect(result.results[0].content).toBe('ok');
  });

  it('permission-denied attempts do not increment hazardous repeat state', async () => {
    let invoked = 0;
    let checks = 0;
    const registry = registryWith({
      name: 'write_file',
      mutates: true,
      executionClass: 'write',
      repeatPolicy: 'mutating',
    }, () => { invoked++; });
    const gate = fakeGate(async () => {
      checks += 1;
      return checks < 3
        ? { allowed: false as const, refusalText: '[user-denied: nope]' }
        : { allowed: true as const };
    });
    const result = await dispatchTools(args(registry, gate, {
      toolUses: [
        { id: 'u1', name: 'write_file', input: { path: 'a.ts' } },
        { id: 'u2', name: 'write_file', input: { path: 'a.ts' } },
        { id: 'u3', name: 'write_file', input: { path: 'a.ts' } },
      ],
    }));
    expect(result.results.slice(0, 2).every((r) => r.refusalKind === 'user_denied')).toBe(true);
    expect(result.results[2].isError).toBe(false);
    expect(result.results[2].guardVerdict?.count).not.toBe(3);
    expect(invoked).toBe(1);
  });
});
