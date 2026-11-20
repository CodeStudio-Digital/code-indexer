/**
 * Fase 2 Policy Engine shadow wiring at the dispatch layer.
 *
 * Proves the zero-behavior-change contract: with no `policyShadow` port the
 * path is identical to the pre-Fase-2 behavior; a shadow port that returns
 * `{ refuse: false }` records but never blocks; and an enforcing port (the
 * dormant `PolicyShadowMode.enforce` path) refuses BEFORE the legacy
 * permission gate is consulted.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { PermissionGate } from '@mcp/code-agent/core/permission-gate.js';
import { buildCodeExecTool } from '@mcp/code-agent/tools/code-exec.js';
import { submitSpec } from '@mcp/code-agent/tools/spec/submit-spec.js';
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

function args(registry: ToolRegistry, extra?: Partial<DispatchArgs>): DispatchArgs {
  const toolContext = { cwd: process.cwd(), projectName: 'test' } as ToolContext;
  return {
    toolUses: [{ id: 'tu1', name: 'run_command', input: { command: 'ls' } }],
    registry,
    toolContext,
    turn: 1,
    ...extra,
  };
}

describe('dispatchTools — policy shadow wiring', () => {
  it('dispatches the real submit_spec approval primitive while spec mode is still locked', async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), 'submit-spec-dispatch-'));
    const registry = new ToolRegistry();
    registry.register(submitSpec);
    const runner = {
      agentId: 'spec',
      emit: vi.fn(),
      waitForUserInput: vi.fn(async () => JSON.stringify({
        approved: false,
        requested_changes: 'Add rollback criteria.',
      })),
      approveSpec: vi.fn(),
    };

    try {
      const result = await dispatchTools(args(registry, {
        toolUses: [{
          id: 'submit-spec-before-approval',
          name: 'submit_spec',
          input: { name: 'Durable Run', body: '# Durable Run\n\n## Context\nTest.' },
        }],
        toolContext: {
          cwd,
          projectName: 'test',
          runner: runner as unknown as NonNullable<ToolContext['runner']>,
        },
        // This is the runner bridge's real spec-mode gate classification:
        // the approval primitive must remain logically non-mutating even
        // though its repository artifact has a physical filesystem boundary.
        toolGate: (toolName) => {
          const tool = registry.get(toolName);
          const mutates = tool?.mutates ?? (tool?.source === 'mcp_external');
          return mutates
            ? '[spec-mode: mutating tool blocked. Call `submit_spec` first.]'
            : null;
        },
      }));

      expect(result.results[0].isError).toBeFalsy();
      expect(runner.waitForUserInput).toHaveBeenCalledOnce();
      expect(readdirSync(resolve(cwd, '.mcp', 'specs'))).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('no policyShadow port → byte-identical legacy path (tool runs)', async () => {
    let invoked = 0;
    const registry = registryWith({ name: 'run_command', riskLevel: 'execute' }, () => { invoked++; });
    const result = await dispatchTools(args(registry));
    expect(invoked).toBe(1);
    expect(result.results[0].content).toBe('ok');
  });

  it('shadow port returning { refuse: false } records but never blocks', async () => {
    let invoked = 0;
    let observed = 0;
    const registry = registryWith({ name: 'run_command', riskLevel: 'execute' }, () => { invoked++; });
    const result = await dispatchTools(args(registry, {
      policyShadow: ({ toolName }) => { observed += 1; void toolName; return { refuse: false }; },
    }));
    expect(observed).toBe(1);
    expect(invoked).toBe(1);
    expect(result.results[0].content).toBe('ok');
  });

  it('enforcing port { refuse: true } refuses without invoking the handler', async () => {
    let invoked = 0;
    const registry = registryWith({ name: 'run_command', riskLevel: 'execute' }, () => { invoked++; });
    const result = await dispatchTools(args(registry, {
      policyShadow: () => ({ refuse: true, refusalText: '[policy-engine: denied by managed org policy]' }),
    }));
    expect(invoked).toBe(0);
    expect(result.results[0]).toMatchObject({ isError: true, refusalKind: 'user_denied', durationMs: 0 });
    expect(result.results[0].content).toContain('policy-engine');
  });

  it('shadow runs BEFORE the legacy permission gate', async () => {
    const order: string[] = [];
    const registry = registryWith({ name: 'run_command', riskLevel: 'execute' });
    const gate = fakeGate(async () => { order.push('gate'); return { allowed: true }; });
    await dispatchTools(args(registry, {
      toolContext: { cwd: process.cwd(), projectName: 'test', permissionGate: gate } as ToolContext,
      policyShadow: () => { order.push('shadow'); return { refuse: false }; },
    }));
    expect(order).toEqual(['shadow', 'gate']);
  });

  it('an enforcing refusal short-circuits the permission gate entirely', async () => {
    const order: string[] = [];
    const registry = registryWith({ name: 'run_command', riskLevel: 'execute' });
    const gate = fakeGate(async () => { order.push('gate'); return { allowed: true }; });
    const result = await dispatchTools(args(registry, {
      toolContext: { cwd: process.cwd(), projectName: 'test', permissionGate: gate } as ToolContext,
      policyShadow: () => { order.push('shadow'); return { refuse: true, refusalText: '[policy-engine: denied]' }; },
    }));
    expect(order).toEqual(['shadow']); // gate never consulted
    expect(result.results[0].isError).toBe(true);
  });

  it('applies the same scoped policy and lifecycle hooks to direct and code_exec nested calls', async () => {
    const registry = new ToolRegistry();
    let editInvocations = 0;
    registry.register({
      name: 'edit_file',
      description: 'edit',
      source: 'native',
      mutates: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          mode: { type: 'string', default: 'safe' },
        },
        required: ['path'],
      },
      handler: async () => {
        editInvocations += 1;
        return { content: 'edited' };
      },
    });
    registry.register(buildCodeExecTool(registry));

    const policyInputs: Array<{
      toolName: string;
      toolUseId: string;
      toolInput: Record<string, unknown>;
      turn: number;
    }> = [];
    const hooks: Array<{
      phase: 'before' | 'after';
      toolName: string;
      toolUseId: string;
      refused?: boolean;
    }> = [];
    const policyShadow: NonNullable<DispatchArgs['policyShadow']> = (input) => {
      policyInputs.push(input);
      return input.toolName === 'edit_file'
        ? { refuse: true, refusalText: '[policy-engine: edit denied]' }
        : { refuse: false };
    };
    const capabilityHooks: NonNullable<DispatchArgs['capabilityHooks']> = {
      before: (input) => {
        hooks.push({ phase: 'before', ...input });
      },
      after: (input) => {
        hooks.push({ phase: 'after', ...input });
      },
    };

    const direct = await dispatchTools(args(registry, {
      toolUses: [{
        id: 'direct-edit',
        name: 'edit_file',
        input: { file_path: './direct.ts' },
      }],
      turn: 7,
      policyShadow,
      capabilityHooks,
    }));
    const nested = await dispatchTools(args(registry, {
      toolUses: [{
        id: 'outer-code-exec',
        name: 'code_exec',
        input: {
          code: `await tools.edit_file({ file_path: './nested.ts' }); return 'unreachable';`,
        },
      }],
      turn: 7,
      policyShadow,
      capabilityHooks,
    }));

    expect(editInvocations).toBe(0);
    expect(direct.results[0]).toMatchObject({
      isError: true,
      refusalKind: 'user_denied',
      content: '[policy-engine: edit denied]',
    });
    expect(nested.results[0].isError).toBe(true);
    expect(nested.results[0].content).toContain('[policy-engine: edit denied]');

    const editPolicies = policyInputs.filter((input) => input.toolName === 'edit_file');
    expect(editPolicies).toHaveLength(2);
    expect(editPolicies.map((input) => input.toolInput.path)).toEqual([
      './direct.ts',
      './nested.ts',
    ]);
    expect(editPolicies.map((input) => input.toolInput.mode)).toEqual(['safe', 'safe']);
    expect(editPolicies.every((input) => input.turn === 7)).toBe(true);

    const nestedPolicy = editPolicies.find((input) => input.toolInput.path === './nested.ts');
    expect(nestedPolicy).toBeDefined();
    const nestedHookPhases = hooks
      .filter((hook) => hook.toolUseId === nestedPolicy!.toolUseId)
      .map((hook) => ({ phase: hook.phase, refused: hook.refused }));
    expect(nestedHookPhases).toEqual([
      { phase: 'before', refused: undefined },
      { phase: 'after', refused: true },
    ]);
  });

  it('reuses disabled-tool and task-mode preflight gates inside code_exec', async () => {
    const registry = new ToolRegistry();
    const invocations = { disabled: 0, task: 0 };
    registry.register({
      name: 'disabled_write',
      description: 'disabled write',
      source: 'native',
      mutates: true,
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        invocations.disabled += 1;
        return { content: 'unexpected disabled invocation' };
      },
    });
    registry.register({
      name: 'task_write',
      description: 'task-mode write',
      source: 'native',
      mutates: true,
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        invocations.task += 1;
        return { content: 'unexpected task invocation' };
      },
    });
    registry.register(buildCodeExecTool(registry));
    const preflight: Partial<DispatchArgs> = {
      isToolBlocked: (name) =>
        name === 'disabled_write' ? '[disabled-tool: managed policy]' : null,
      enforceTaskMode: (name) =>
        name === 'task_write' ? '[task-mode: use execute_task]' : null,
    };

    const directDisabled = await dispatchTools(args(registry, {
      ...preflight,
      toolUses: [{ id: 'direct-disabled', name: 'disabled_write', input: {} }],
    }));
    const directTask = await dispatchTools(args(registry, {
      ...preflight,
      toolUses: [{ id: 'direct-task', name: 'task_write', input: {} }],
    }));
    const nested = await dispatchTools(args(registry, {
      ...preflight,
      toolUses: [{
        id: 'nested-preflight',
        name: 'code_exec',
        input: {
          code: `
            const denied = {};
            try { await tools.disabled_write({}); }
            catch (e) { denied.disabled = e.detail; }
            try { await tools.task_write({}); }
            catch (e) { denied.task = e.detail; }
            return denied;
          `,
        },
      }],
    }));

    expect(invocations).toEqual({ disabled: 0, task: 0 });
    expect(directDisabled.results[0].content).toBe('[disabled-tool: managed policy]');
    expect(directTask.results[0].content).toBe('[task-mode: use execute_task]');
    expect(nested.results[0]).toMatchObject({ isError: false });
    expect(nested.results[0].content).toContain('[disabled-tool: managed policy]');
    expect(nested.results[0].content).toContain('[task-mode: use execute_task]');
  });

  it('binds nested handler context to its own tool id and the visible outer parent', async () => {
    const registry = new ToolRegistry();
    let seen: { current?: string; parent?: string } | undefined;
    registry.register({
      name: 'nested_read',
      description: 'nested read',
      source: 'native',
      mutates: false,
      parameters: { type: 'object', properties: {} },
      handler: async (_input, ctx) => {
        seen = {
          current: ctx.currentToolUseId,
          parent: ctx.parentToolUseId,
        };
        return { content: 'ok' };
      },
    });
    registry.register(buildCodeExecTool(registry));

    const result = await dispatchTools(args(registry, {
      toolUses: [{
        id: 'visible-code-exec',
        name: 'code_exec',
        input: { code: `return await tools.nested_read({});` },
      }],
    }));

    expect(result.results[0].isError).toBe(false);
    expect(seen?.current).toMatch(/^nx_/);
    expect(seen?.current).not.toBe('visible-code-exec');
    expect(seen?.parent).toBe('visible-code-exec');
  });
});
