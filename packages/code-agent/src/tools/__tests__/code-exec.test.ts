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
