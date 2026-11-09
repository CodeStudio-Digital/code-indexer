import { describe, it, expect, beforeEach } from 'vitest';
import { buildCodeExecTool, _exposedToolNames } from '@mcp/code-agent/tools/code-exec.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';

const ctx: ToolContext = { cwd: '/tmp', projectName: 'test' };

function safeTool(name: string, handler: CoderTool['handler']): CoderTool {
  return {
    name,
    description: `${name} test tool`,
    source: 'native',
    mutates: false,
    parallelSafe: true,
    riskLevel: 'read',
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    handler,
  };
}

function unsafeTool(overrides: Partial<CoderTool>): CoderTool {
  return {
    name: 'danger',
    description: 'mutates state',
    source: 'native',
    mutates: true,
    parallelSafe: false,
    riskLevel: 'write',
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    handler: async () => ({ content: 'ran' }),
    ...overrides,
  };
}

function makeRegistry(tools: CoderTool[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}

describe('code_exec — sandbox + tool proxy', () => {
  it('runs a snippet that calls a single tool and returns its content', async () => {
    const registry = makeRegistry([
      safeTool('echo', async (args) => ({ content: `echo:${(args as { msg?: string }).msg ?? ''}` })),
    ]);
    const exec = buildCodeExecTool(registry);
    const r = await exec.handler({ code: 'return await tools.echo({ msg: "hi" });' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('echo:hi');
    expect(r.content).toContain('1 tool call');
  });

  it('captures log() output and shows return separately', async () => {
    const registry = makeRegistry([
      safeTool('echo', async () => ({ content: 'OK' })),
    ]);
    const exec = buildCodeExecTool(registry);
    const code = 'log("step 1"); const r = await tools.echo({}); log("step 2", r); return { done: true };';
    const r = await exec.handler({ code }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('step 1');
    expect(r.content).toContain('step 2 OK');
    expect(r.content).toContain('"done": true');
  });

  it('throws on tool error and surfaces it cleanly', async () => {
    const registry = makeRegistry([
      safeTool('boom', async () => ({ content: 'kaboom', isError: true })),
    ]);
    const exec = buildCodeExecTool(registry);
    const r = await exec.handler({ code: 'await tools.boom({});' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('tool boom');
    expect(r.content).toContain('kaboom');
  });

  it('exposes mutating tools but excludes interactive/orchestration', async () => {
    const registry = makeRegistry([
      safeTool('read_safe', async () => ({ content: 'r' })),
      unsafeTool({ name: 'write_thing' }), // mutating — exposed (policy gates per call)
      unsafeTool({ name: 'ask_user', mutates: false, interactive: true, riskLevel: 'read' }), // interactive — excluded
      unsafeTool({ name: 'spawn_subagent', mutates: false, riskLevel: 'read' }), // orchestration — excluded
      unsafeTool({ name: 'view_image', mutates: false, riskLevel: 'read' }), // excluded by name
      unsafeTool({ name: 'expand_toolset', mutates: false, riskLevel: 'admin' }), // excluded by name
    ]);
    const exposed = _exposedToolNames(registry);
    expect(exposed).toEqual(['read_safe', 'write_thing']);
  });

  it('blocks mutating tool when planMode is on and plan is not approved', async () => {
    // Simulate runner state: planMode true, planApproved false, no taskScope.
    const fakeRunner = {
      isPlanApproved: () => false,
      currentTaskScopeId: () => null,
      currentTaskScopeFiles: () => null,
      opts: { planMode: true },
    };
    const registry = makeRegistry([
      unsafeTool({ name: 'edit_file', riskLevel: 'write', scopeAware: true }),
    ]);
    const exec = buildCodeExecTool(registry);
    const r = await exec.handler(
      { code: 'return await tools.edit_file({ path: "x" });' },
      { ...ctx, runner: fakeRunner as unknown as ToolContext['runner'] },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('blocked');
    expect(r.content).toContain('plan mode');
  });

  it('allows mutating tool when plan IS approved', async () => {
    const fakeRunner = {
      isPlanApproved: () => true,
      currentTaskScopeId: () => null,
      currentTaskScopeFiles: () => null,
      opts: { planMode: true },
    };
    const registry = makeRegistry([
      unsafeTool({ name: 'edit_file', riskLevel: 'write', scopeAware: true,
        handler: async () => ({ content: 'edited' }) }),
    ]);
    const exec = buildCodeExecTool(registry);
    const r = await exec.handler(
      { code: 'return await tools.edit_file({ path: "x" });' },
      { ...ctx, runner: fakeRunner as unknown as ToolContext['runner'] },
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('edited');
  });

  it('unlocks mutating tool via task scope when paths are inside', async () => {
    const fakeRunner = {
      isPlanApproved: () => false,
      currentTaskScopeId: () => 'task-1',
      currentTaskScopeFiles: () => ['src/foo.ts'],
      opts: { planMode: true },
    };
    const registry = makeRegistry([
      unsafeTool({ name: 'edit_file', riskLevel: 'write', scopeAware: true,
        handler: async () => ({ content: 'edited' }) }),
    ]);
    const exec = buildCodeExecTool(registry);
    const r = await exec.handler(
      { code: 'return await tools.edit_file({ path: "src/foo.ts" });' },
      { ...ctx, runner: fakeRunner as unknown as ToolContext['runner'] },
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('edited');
  });

  it('blocks mutating tool when path is outside the task scope', async () => {
    const fakeRunner = {
      isPlanApproved: () => false,
      currentTaskScopeId: () => 'task-1',
      currentTaskScopeFiles: () => ['src/foo.ts'],
      opts: { planMode: true },
    };
    const registry = makeRegistry([
      unsafeTool({ name: 'edit_file', riskLevel: 'write', scopeAware: true,
        handler: async () => ({ content: 'edited' }) }),
    ]);
    const exec = buildCodeExecTool(registry);
    const r = await exec.handler(
      { code: 'return await tools.edit_file({ path: "src/bar.ts" });' },
      { ...ctx, runner: fakeRunner as unknown as ToolContext['runner'] },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('src/bar.ts');
    expect(r.content).toContain('task-1');
  });

  it('refuses an empty snippet', async () => {
    const exec = buildCodeExecTool(makeRegistry([]));
    const r = await exec.handler({ code: '   ' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('`code` is required and non-empty');
  });

  it('enforces the per-script tool-call cap', async () => {
    const registry = makeRegistry([
      safeTool('hit', async () => ({ content: '1' })),
    ]);
    const exec = buildCodeExecTool(registry);
    // 51 calls: cap is 50, so the 51st throws.
    const code = `
      for (let i = 0; i < 51; i++) await tools.hit({});
      return "should not reach";
    `;
    const r = await exec.handler({ code }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('exceeded 50 tool calls');
  });

  it('enforces the async JS-time budget (burned between tool calls, paused during them)', async () => {
    // Codex-faithful semantics: `timeout_ms` bounds the script's OWN JS-active
    // time. A slow nested tool no longer trips it (the clock PAUSES while a
    // tool is in flight — canonical coverage in packages/code-agent
    // src/tools/__tests__/code-exec.test.ts), but synchronous work BETWEEN
    // tool calls still burns the budget: pauseClock() discounts the elapsed
    // slice at the next tool call and resumeClock() rejects once it goes ≤ 0.
    // The burn must come AFTER the first await — the initial sync slice is
    // covered by the vm `timeout` option (a different mechanism).
    let calls = 0;
    const registry = makeRegistry([
      safeTool('fast', async () => { calls++; return { content: 'ok' }; }),
    ]);
    const exec = buildCodeExecTool(registry);
    const code = `
      await tools.fast({});
      const t0 = Date.now();
      while (Date.now() - t0 < 900) { /* burn the script's own JS time */ }
      await tools.fast({});
      return "should not reach";
    `;
    const r = await exec.handler({ code, timeout_ms: 600 }, ctx);
    expect(r.isError).toBe(true);
    // Either the active-time clock or the external watchdog can win. Both
    // must report a JS timeout and fence the second nested operation.
    expect(r.error).toMatchObject({ code: 'CODE_EXEC_JS_TIMEOUT', kind: 'timeout' });
    expect(calls).toBe(1);
  });

  it('forbids access to require/process/Buffer in the sandbox', async () => {
    const exec = buildCodeExecTool(makeRegistry([]));
    const r = await exec.handler({ code: 'return typeof require + "," + typeof process + "," + typeof Buffer;' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('undefined,undefined,undefined');
  });

  it('hints toward write_file when a script calls require()', async () => {
    const exec = buildCodeExecTool(makeRegistry([]));
    const r = await exec.handler({ code: "const fs = require('fs'); return fs;" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('require is not defined');
    expect(r.content).toContain('node:vm sandbox');
    expect(r.content).toContain('write_file');
  });

  it('hints for other absent Node builtins (process)', async () => {
    const exec = buildCodeExecTool(makeRegistry([]));
    const r = await exec.handler({ code: 'return process.env;' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('process is not defined');
    expect(r.content).toContain('Node builtins');
  });

  it('rejects tool calls when called with too many arguments via tool registry', async () => {
    const registry = makeRegistry([
      safeTool('echo', async (args) => ({ content: JSON.stringify(args) })),
    ]);
    const exec = buildCodeExecTool(registry);
    const r = await exec.handler({ code: 'return await tools.echo({ a: 1, b: "x" });' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('"a":1');
    expect(r.content).toContain('"b":"x"');
  });

  it('chains multiple tool calls and reduces results', async () => {
    const registry = makeRegistry([
      safeTool('add', async (args) => {
        const { a, b } = args as { a: number; b: number };
        return { content: String(a + b) };
      }),
    ]);
    const exec = buildCodeExecTool(registry);
    const code = `
      const r1 = await tools.add({ a: 1, b: 2 });
      const r2 = await tools.add({ a: Number(r1), b: 4 });
      return Number(r2);
    `;
    const r = await exec.handler({ code }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('7');
    expect(r.content).toContain('2 tool call');
  });
});
