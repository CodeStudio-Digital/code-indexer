/**
 * Tests for the codex-faithful `code_exec` timeout semantics.
 *
 * The script timeout measures the script's OWN JS-active time and is PAUSED
 * while a nested tool call is in flight (so a long `run_command` install isn't
 * killed by the script clock). Each nested tool is bounded by its own tier, and
 * a tool-free synchronous spin still trips the budget. Shell/mutating tools stay
 * exposed inside `code_exec`.
 */
import { describe, expect, it } from 'vitest';
import { buildCodeExecTool, _exposedToolNames } from '@mcp/code-agent/tools/code-exec.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ok, type CoderTool, type ToolContext } from '@mcp/code-agent/core/tool.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeCtx(): ToolContext {
  return { cwd: process.cwd(), projectName: 'code-exec-test' };
}

/** A read-style tool that resolves after `ms`, mirroring a slow nested call. */
function slowTool(name: string, ms: number): CoderTool {
  return {
    name,
    description: 'slow',
    source: 'native',
    mutates: false,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      await sleep(ms);
      return ok(`${name}-done`);
    },
  };
}

/** A tool that never resolves but declares a tiny `timeoutMs`. */
function hangTool(name: string, timeoutMs: number): CoderTool {
  return {
    name,
    description: 'hang',
    source: 'native',
    mutates: false,
    timeoutMs,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => new Promise<never>(() => {}),
  };
}

/** A bare placeholder so `_exposedToolNames` has something to report. */
function noopTool(name: string): CoderTool {
  return {
    name,
    description: 'noop',
    source: 'native',
    mutates: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ok(`${name}-ok`),
  };
}

describe('code_exec timeout (codex-faithful)', () => {
  it('does NOT time out while awaiting a nested tool slower than the JS budget', async () => {
    const registry = new ToolRegistry();
    // Budget floor is 500ms; the tool sleeps longer, but the clock is paused
    // while it runs, so the script completes.
    registry.register(slowTool('slow_read', 700));
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      { code: `const r = await tools.slow_read({}); return r;`, timeout_ms: 500 },
      makeCtx(),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('slow_read-done');
  });

  it('still trips the budget on a tool-free synchronous spin', async () => {
    const registry = new ToolRegistry();
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      { code: `let x = 0; while (true) { x++; }`, timeout_ms: 500 },
      makeCtx(),
    );

    expect(res.isError).toBe(true);
    // The node:vm sync `timeout` option catches a synchronous infinite loop.
    expect(res.content).toMatch(/timed out|parse\/sync error/i);
  });

  it('bounds a hung nested tool by its own per-tool timeout', async () => {
    const registry = new ToolRegistry();
    registry.register(hangTool('hang_read', 50));
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      { code: `await tools.hang_read({}); return 'unreachable';` },
      makeCtx(),
    );

    expect(res.isError).toBe(true);
    expect(res.content).toContain('hang_read timed out after 50 ms');
  });

  it('keeps shell/mutating tools exposed inside code_exec', () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('run_command'));
    registry.register(noopTool('exec_command'));
    registry.register(noopTool('read_file'));

    const exposed = _exposedToolNames(registry);
    expect(exposed).toContain('run_command');
    expect(exposed).toContain('exec_command');
    expect(exposed).toContain('read_file');
  });
});

describe('code_exec ReferenceError hints', () => {
  it('steers a sandbox-excluded control tool to a top-level call', async () => {
    const registry = new ToolRegistry();
    // `task_complete` is registered (callable at top-level) but `isSafeTool`
    // excludes it from the sandbox. Calling it inside code_exec throws a bare
    // ReferenceError — the hint must tell the model to call it directly. This
    // is the exact loop that burned ~18 turns in session 966.
    registry.register(noopTool('task_complete'));
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      { code: `await task_complete({}); return 'done';` },
      makeCtx(),
    );

    expect(res.isError).toBe(true);
    expect(res.content).toContain('task_complete is not defined');
    expect(res.content).toContain('NOT exposed inside code_exec');
    expect(res.content).toContain('top-level tool call');
  });

  it('does NOT emit the control-tool hint for an unknown identifier', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('read_file'));
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      { code: `await totally_made_up_xyz({}); return 'done';` },
      makeCtx(),
    );

    expect(res.isError).toBe(true);
    expect(res.content).toContain('totally_made_up_xyz is not defined');
    expect(res.content).not.toContain('NOT exposed inside code_exec');
  });
});

describe('code_exec permission gate (nested calls)', () => {
  /** Fake PermissionGate — the real class is covered by permission-gate.test.ts. */
  function gateCtx(
    check: (req: { toolName: string; parentToolUseId?: string; nested?: boolean }) => Promise<{ allowed: true } | { allowed: false; refusalText: string }>,
  ): ToolContext {
    return {
      ...makeCtx(),
      currentToolUseId: 'ce_block_1',
      permissionGate: { check, pendingCount: () => 0 } as unknown as ToolContext['permissionGate'],
    };
  }

  it('denial reaches the script as a JS exception (finally restores clock/inFlight)', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('run_command'));
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      { code: `await tools.run_command({ command: 'ls' }); return 'unreachable';` },
      gateCtx(async () => ({ allowed: false, refusalText: '[user-denied: o usuário negou permissão para `run_command`.]' })),
    );

    expect(res.isError).toBe(true);
    expect(res.content).toContain('[user-denied');
  });

  it('a denied call does not kill the script — try/catch keeps running', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('run_command'));
    registry.register(noopTool('read_file'));
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      {
        code: `
          let denied = false;
          try { await tools.run_command({}); } catch (e) { denied = String(e).includes('user-denied'); }
          const r = await tools.read_file({});
          return JSON.stringify({ denied, r });
        `,
      },
      gateCtx(async (req) =>
        req.toolName === 'run_command'
          ? { allowed: false, refusalText: '[user-denied: negado.]' }
          : { allowed: true }),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('"denied":true');
    expect(res.content).toContain('read_file-ok');
  });

  it('anchors nested requests to the code_exec block (parentToolUseId + nested)', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('run_command'));
    const codeExec = buildCodeExecTool(registry);
    const seen: Array<{ parent?: string; nested?: boolean }> = [];

    const res = await codeExec.handler(
      { code: `await tools.run_command({}); return 'done';` },
      gateCtx(async (req) => {
        seen.push({ parent: req.parentToolUseId, nested: req.nested });
        return { allowed: true };
      }),
    );

    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ parent: 'ce_block_1', nested: true }]);
  });

  it('no gate on the context → nested calls run free (legacy)', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('run_command'));
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      { code: `const r = await tools.run_command({}); return r;` },
      makeCtx(),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('run_command-ok');
  });
});
