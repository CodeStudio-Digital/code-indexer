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
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';

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

describe('code_exec import hints (telemetry: "A dynamic import callback was not specified")', () => {
  it('hints on dynamic import()', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('read_file'));
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler({ code: `const fs = await import('fs'); return 'x';` }, makeCtx());

    expect(res.isError).toBe(true);
    expect(res.content).toContain('dynamic import callback');
    expect(res.content).toContain('NO module loader');
  });

  it('hints on a static import statement (parse-time failure)', async () => {
    const registry = new ToolRegistry();
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler({ code: `import fs from 'fs';\nreturn 'x';` }, makeCtx());

    expect(res.isError).toBe(true);
    expect(res.content).toContain('parse/sync error');
    expect(res.content).toContain('NO module loader');
  });
});

describe('code_exec tools-proxy misses (telemetry: "tools.X is not a function")', () => {
  it('throws a suggestion-bearing error on an unknown tools.<name> access', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('mcp__grep_code'));
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      { code: `await tools.grep_code({ query: 'x' }); return 'done';` },
      makeCtx(),
    );

    expect(res.isError).toBe(true);
    expect(res.content).toContain('tools.grep_code is not an available tool');
    expect(res.content).toContain('did you mean `tools.mcp__grep_code`?');
    expect(res.content).toContain('log(Object.keys(tools)');
  });

  it('the miss is catchable, and introspection still works', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('read_file'));
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      {
        code: `
          let missed = false;
          try { await tools.not_a_tool({}); } catch (e) { missed = String(e).includes('not an available tool'); }
          return JSON.stringify({ missed, keys: Object.keys(tools).sort() });
        `,
      },
      makeCtx(),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('"missed":true');
    expect(res.content).toContain('"read_file"');
  });
});

describe('code_exec nested loop guards (observer wired via ToolContext)', () => {
  it('a script looping the SAME nested call is interrupted by the dedup guard', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('read_file'));
    const codeExec = buildCodeExecTool(registry);

    const { buildNestedToolObserver } = await import('@mcp/code-agent/core/runner/guards/nested-observer.js');
    const observer = buildNestedToolObserver({
      dupCalls: new Map(),
      failureStreaks: { streaks: new Map() },
      turn: 1,
      parentToolUseId: 'ce_loop_1',
    });

    const res = await codeExec.handler(
      {
        code: `
          for (let i = 0; i < 10; i++) {
            await tools.read_file({ path: 'same.ts' });
          }
          return 'finished all 10';
        `,
      },
      { ...makeCtx(), nestedToolObserver: observer },
    );

    expect(res.isError).toBe(true);
    expect(res.content).toContain('tool read_file refused');
    expect(res.content).toContain('[loop-refused');
    expect(res.content).not.toContain('finished all 10');
  });

  it('without an observer (tests/subagents/kill-switch) nothing changes', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('read_file'));
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      {
        code: `
          for (let i = 0; i < 5; i++) await tools.read_file({ path: 'same.ts' });
          return 'finished';
        `,
      },
      makeCtx(),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('finished');
  });
});

describe('code_exec metadata safety and scheduling', () => {
  it('exposes nested dedup refusals as structured catchable errors', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('read_file'));
    const observer = {
      beforeNestedCall: () => ({ refusalText: 'duplicate call', kind: 'dedup' as const }),
      afterNestedCall: () => {},
    };
    const result = await buildCodeExecTool(registry).handler({
      code: `
        try { await tools.read_file({path:'x'}); }
        catch (e) { return { code: e.code, kind: e.refusalKind, tool: e.tool }; }
      `,
    }, { ...makeCtx(), nestedToolObserver: observer });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('"code": "TOOL_CALL_REFUSED"');
    expect(result.content).toContain('"kind": "dedup"');
    expect(result.content).toContain('"tool": "read_file"');
  });

  it('records policy refusals in the shared ledger without executing the tool', async () => {
    const registry = new ToolRegistry();
    let invoked = false;
    registry.register({
      ...noopTool('edit_file'),
      handler: async () => { invoked = true; return ok('unexpected'); },
    });
    const entries: unknown[] = [];
    const ledger = {
      record(input: unknown) {
        entries.push(input);
        return {
          seq: entries.length, name: 'edit_file', logicalOperationId: 'op', productive: false,
          isError: true, refusalKind: 'gate', resultFingerprint: 'x', outcome: 'refusal',
          durationMs: 0, resultNovel: true, coverageNovel: false,
        };
      },
    };
    const result = await buildCodeExecTool(registry).handler({
      code: `try { await tools.edit_file({path:'x'}); } catch (e) { return e.refusalKind; }`,
    }, {
      ...makeCtx(),
      toolCallLedger: ledger as never,
      runner: {
        isPlanApproved: () => false,
        currentTaskScopeId: () => null,
        currentTaskScopeFiles: () => null,
        opts: { planMode: true },
      } as never,
    });
    expect(invoked).toBe(false);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ refusalKind: 'gate', isError: true });
    expect(result.content).toContain('[return]\ngate');
  });

  it('withholds policy-interactive tools even when the raw tool flag is absent', () => {
    const registry = new ToolRegistry();
    for (const name of ['ask_user', 'decision_gate', 'submit_plan', 'submit_tasks', 'task_list']) {
      registry.register(noopTool(name));
    }
    registry.register(noopTool('read_file'));
    expect(_exposedToolNames(registry)).toContain('read_file');
    for (const name of ['ask_user', 'decision_gate', 'submit_plan', 'submit_tasks', 'task_list']) {
      expect(_exposedToolNames(registry)).not.toContain(name);
    }
  });

  it('serializes mutating calls issued through Promise.all', async () => {
    const registry = new ToolRegistry();
    let active = 0;
    let maxActive = 0;
    registry.register({
      ...noopTool('edit_file'),
      mutates: true,
      parallelSafe: false,
      handler: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(20);
        active--;
        return ok('done');
      },
    });
    const result = await buildCodeExecTool(registry).handler({
      code: `return await Promise.all([tools.edit_file({n:1}), tools.edit_file({n:2})]);`,
    }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(maxActive).toBe(1);
  });

  it('still permits parallel-safe reads to overlap', async () => {
    const registry = new ToolRegistry();
    let active = 0;
    let maxActive = 0;
    registry.register({
      ...slowTool('read_file', 1),
      parallelSafe: true,
      handler: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(20);
        active--;
        return ok('done');
      },
    });
    const result = await buildCodeExecTool(registry).handler({
      code: `return await Promise.all([tools.read_file({n:1}), tools.read_file({n:2})]);`,
    }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(maxActive).toBe(2);
  });

  it('keeps the shared mutation lane locked after timeout until a non-cancellable tool settles', async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...noopTool('edit_file'),
      timeoutMs: 20,
      mutates: true,
      parallelSafe: false,
      handler: async () => {
        await sleep(80); // deliberately ignores ctx.signal
        return ok('late write finished');
      },
    });
    const ledger = new ToolCallLedger();
    const result = await buildCodeExecTool(registry).handler({
      code: `await tools.edit_file({path:'x'}); return 'unexpected';`,
    }, { ...makeCtx(), toolCallLedger: ledger });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out');

    let acquired = false;
    const queued = ledger.reserveUnsafe().then((release) => {
      acquired = true;
      release();
    });
    await sleep(25);
    expect(acquired).toBe(false);
    await queued;
    expect(acquired).toBe(true);
  });
});

describe('code_exec nested-failure try/catch hint (telemetry: create_file killed the script)', () => {
  /** A tool that always reports isError, like create_file on an existing path. */
  function errTool(name: string, message: string): CoderTool {
    return {
      name,
      description: 'always errors',
      source: 'native',
      mutates: true,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ({ content: message, isError: true }),
    };
  }

  it('appends the try/catch hint when a nested tool failure aborts the script', async () => {
    const registry = new ToolRegistry();
    registry.register(errTool('create_file', 'File a.md already exists. Use write_file or edit_file.'));
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      { code: `await tools.create_file({}); return 'unreachable';` },
      makeCtx(),
    );

    expect(res.isError).toBe(true);
    expect(res.content).toContain('tool create_file: File a.md already exists');
    expect(res.content).toContain('aborted the WHOLE script');
    expect(res.content).toContain('wrap THAT call in try/catch');
  });

  it('a script that already uses try/catch survives and finishes', async () => {
    const registry = new ToolRegistry();
    registry.register(errTool('create_file', 'File a.md already exists.'));
    registry.register(noopTool('read_file'));
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      {
        code: `
          let existed = false;
          try { await tools.create_file({}); } catch (e) { existed = String(e).includes('already exists'); }
          const r = await tools.read_file({});
          return JSON.stringify({ existed, r });
        `,
      },
      makeCtx(),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('"existed":true');
    expect(res.content).toContain('read_file-ok');
  });
});

describe('code_exec tier-agnostic discovery (list_tools / tool_schema)', () => {
  /** A tool whose NAME resolves to the navigate tier (hidden from a bootstrap toolset). */
  const navTool = () => noopTool('mcp__find_references'); // getToolTier → 'navigate'

  it('list_tools() enumerates the full callable catalog incl. a non-bootstrap-tier tool', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('read_file'));
    registry.register(navTool());
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      { code: `return JSON.stringify(list_tools());` },
      makeCtx(),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('"name":"mcp__find_references"');
    // The whole point: a navigate-tier tool shows up with its real tier even
    // though nothing about the agent's active tier is consulted here.
    expect(res.content).toContain('"tier":"navigate"');
    expect(res.content).toContain('"name":"read_file"');
  });

  it('calls a non-bootstrap-tier tool WITHOUT expand_toolset', async () => {
    const registry = new ToolRegistry();
    registry.register(navTool());
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      { code: `const r = await tools.mcp__find_references({ symbol: 'x' }); return r;` },
      makeCtx(),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('mcp__find_references-ok');
  });

  it('tool_schema(name) returns a callable tool\'s full JSON schema', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('edit_file'));
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      { code: `return JSON.stringify(tool_schema('edit_file'));` },
      makeCtx(),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('"name":"edit_file"');
    expect(res.content).toContain('"schema"');
    expect(res.content).toContain('"type":"object"');
  });

  it('tool_schema steers a sandbox-excluded control tool to a direct call', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('read_file'));
    registry.register(noopTool('task_complete')); // registered but isSafeTool=false
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      { code: `try { tool_schema('task_complete'); } catch (e) { return String(e); } return 'no throw';` },
      makeCtx(),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('NOT callable inside code_exec');
  });

  it('tool_schema suggests the closest name on a typo', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('read_file'));
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      { code: `try { tool_schema('read_fil'); } catch (e) { return String(e); } return 'no throw';` },
      makeCtx(),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('unknown tool "read_fil"');
    expect(res.content).toContain('did you mean "read_file"');
  });
});

describe('code_exec tier-agnostic exposure still obeys per-call policy', () => {
  /** Minimal fake runner that puts the policy context into unapproved plan mode. */
  function planModeCtx(): ToolContext {
    return {
      ...makeCtx(),
      runner: {
        opts: { planMode: true },
        isPlanApproved: () => false,
        currentTaskScopeId: () => null,
        currentTaskScopeFiles: () => null,
      } as unknown as ToolContext['runner'],
    };
  }

  it('blocks a mutating tool in unapproved plan mode (escape hatch is NOT policy-free)', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('edit_file')); // mutates:true + scopeAware via builtin
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      { code: `await tools.edit_file({ path: 'a.ts', old_string: 'x', new_string: 'y' }); return 'unreachable';` },
      planModeCtx(),
    );

    expect(res.isError).toBe(true);
    expect(res.content).toContain('blocked');
    expect(res.content).toContain('plan mode');
    expect(res.content).not.toContain('unreachable');
  });
});
