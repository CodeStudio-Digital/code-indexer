/**
 * Tests for the codex-faithful `code_exec` timeout semantics.
 *
 * The script timeout measures the script's OWN JS-active time and is PAUSED
 * while a nested tool call is in flight (so a long `run_command` install isn't
 * killed by the script clock). Each nested tool is bounded by its own tier, and
 * a tool-free synchronous spin still trips the budget. Shell/mutating tools stay
 * exposed inside `code_exec`.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildCodeExecTool, _exposedToolNames } from '@mcp/code-agent/tools/code-exec.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ok, type CoderTool, type GuardVerdict, type ToolContext } from '@mcp/code-agent/core/tool.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import { dispatchTools } from '@mcp/code-agent/core/runner/nodes/executing-dispatch.js';
import { invocationGuardKey } from '@mcp/code-agent/core/runner/guards/tuple-hash-dedup.js';

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

  it('a permission denial does not advance the nested guard counter', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('edit_file'));
    const beforeNestedCall = vi.fn(() => null);
    const result = await buildCodeExecTool(registry).handler({
      code: `try { await tools.edit_file({path:'x'}); } catch (e) { return e.refusalKind; }`,
    }, {
      ...gateCtx(async () => ({ allowed: false, refusalText: '[user-denied: no.]' })),
      nestedToolObserver: { beforeNestedCall, afterNestedCall: () => {} },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('[return]\nuser_denied');
    expect(beforeNestedCall).not.toHaveBeenCalled();
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
  it('a script looping the SAME unsafe mutation is interrupted by the local guard', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('edit_file'));
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
            await tools.edit_file({ path: 'same.ts' });
          }
          return 'finished all 10';
        `,
      },
      { ...makeCtx(), nestedToolObserver: observer },
    );

    expect(res.isError).toBe(true);
    expect(res.content).toContain('tool edit_file refused');
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

describe('code_exec invocation-local stable reuse', () => {
  function stableRead(
    handler: CoderTool['handler'],
  ): CoderTool {
    return {
      name: 'read_file',
      description: 'stable read',
      source: 'native',
      mutates: false,
      parallelSafe: true,
      repeatPolicy: 'stable',
      executionClass: 'read',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          force_reread: { type: 'boolean', default: false },
        },
        required: ['path'],
        additionalProperties: false,
      },
      handler,
    };
  }

  it('coalesces concurrent stable reads after alias/default normalization', async () => {
    const registry = new ToolRegistry();
    let invocations = 0;
    const verdicts: Array<GuardVerdict | undefined> = [];
    registry.register(stableRead(async (args) => {
      invocations += 1;
      await sleep(20);
      return ok(`read:${args.path}`);
    }));

    const result = await buildCodeExecTool(registry).handler({
      code: `const pair = await Promise.all([
        tools.read_file({path:'same.ts'}),
        tools.read_file({file_path:'same.ts', force_reread:false})
      ]);
      const settledReuse = await tools.read_file({path:'same.ts'});
      return [...pair, settledReuse];`,
    }, {
      ...makeCtx(),
      currentToolUseId: 'parent-read',
      nestedToolObserver: {
        beforeNestedCall: () => null,
        afterNestedCall: (event) => { verdicts.push(event.guardVerdict); },
      },
    });

    expect(result.isError).toBeFalsy();
    expect(invocations).toBe(1);
    expect(result.content.match(/read:same\.ts/g)).toHaveLength(3);
    expect(verdicts.find((verdict) => verdict?.action === 'reuse')).toMatchObject({
      action: 'reuse',
      count: 2,
      originToolUseId: 'parent-read#1',
    });
  });

  it('force_reread bypasses local reuse', async () => {
    const registry = new ToolRegistry();
    let invocations = 0;
    registry.register(stableRead(async () => ok(`fresh:${++invocations}`)));

    const result = await buildCodeExecTool(registry).handler({
      code: `return [
        await tools.read_file({path:'same.ts'}),
        await tools.read_file({path:'same.ts', force_reread:true})
      ];`,
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(invocations).toBe(2);
    expect(result.content).toContain('fresh:1');
    expect(result.content).toContain('fresh:2');
  });

  it('volatile and pollable calls always execute', async () => {
    const registry = new ToolRegistry();
    let volatileCalls = 0;
    let pollCalls = 0;
    registry.register({
      ...stableRead(async () => ok(`volatile:${++volatileCalls}`)),
      name: 'live_status',
      repeatPolicy: 'volatile',
    });
    registry.register({
      ...stableRead(async () => ok(`poll:${++pollCalls}`)),
      name: 'poll_status',
      repeatPolicy: 'pollable',
    });

    const result = await buildCodeExecTool(registry).handler({
      code: `return await Promise.all([
        tools.live_status({path:'x'}), tools.live_status({path:'x'}),
        tools.poll_status({path:'x'}), tools.poll_status({path:'x'})
      ]);`,
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(volatileCalls).toBe(2);
    expect(pollCalls).toBe(2);
  });

  it('a successful write advances the epoch and invalidates stable reuse', async () => {
    const registry = new ToolRegistry();
    let reads = 0;
    registry.register(stableRead(async () => ok(`version:${++reads}`)));
    registry.register(noopTool('edit_file'));

    const result = await buildCodeExecTool(registry).handler({
      code: `
        const before = await tools.read_file({path:'a.ts'});
        await tools.edit_file({path:'a.ts'});
        const after = await tools.read_file({path:'a.ts'});
        return {before, after};
      `,
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(reads).toBe(2);
    expect(result.content).toContain('version:1');
    expect(result.content).toContain('version:2');
  });

  it('does not reuse results across separate code_exec scripts', async () => {
    const registry = new ToolRegistry();
    let reads = 0;
    registry.register(stableRead(async () => ok(`read:${++reads}`)));
    const codeExec = buildCodeExecTool(registry);
    const input = { code: `return await tools.read_file({path:'a.ts'});` };

    expect((await codeExec.handler(input, makeCtx())).isError).toBeFalsy();
    expect((await codeExec.handler(input, makeCtx())).isError).toBeFalsy();
    expect(reads).toBe(2);
  });

  it('a populated legacy table cannot discard any Promise.all sibling', async () => {
    vi.stubEnv('CODER_DEDUP_POLICY', 'hybrid');
    const registry = new ToolRegistry();
    registry.register(stableRead(async (args) => ok(`result:${args.path}`)));
    const { buildNestedToolObserver } = await import('@mcp/code-agent/core/runner/guards/nested-observer.js');
    const priorExactRead = invocationGuardKey('read_file', {
      path: 'component.ts',
      force_reread: false,
    });
    const observer = buildNestedToolObserver({
      dupCalls: new Map([[priorExactRead, { count: 2, firstTurn: 1, lastUseId: 'old' }]]),
      failureStreaks: { streaks: new Map() },
      turn: 2,
      parentToolUseId: 'parent-batch',
    });

    const result = await buildCodeExecTool(registry).handler({
      code: `return await Promise.all([
        tools.read_file({path:'component.ts'}),
        tools.read_file({path:'template.html'}),
        tools.read_file({path:'spec.ts'}),
        tools.read_file({path:'service.php'})
      ]);`,
    }, { ...makeCtx(), nestedToolObserver: observer });
    vi.unstubAllEnvs();

    expect(result.isError).toBeFalsy();
    for (const path of ['component.ts', 'template.html', 'spec.ts', 'service.php']) {
      expect(result.content).toContain(`result:${path}`);
    }
  });
});

describe('code_exec metadata safety and scheduling', () => {
  it('does not deadlock the shared unsafe lane when dispatched with nested shell work', async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...noopTool('run_command'),
      mutates: false,
      parallelSafe: false,
      handler: async () => ok('git status complete'),
    });
    const codeExec = buildCodeExecTool(registry);
    codeExec.timeoutMs = 200;
    registry.register(codeExec);
    const result = await dispatchTools({
      toolUses: [{
        id: 'parent-code-exec',
        name: 'code_exec',
        input: { code: `return await tools.run_command({command:'git status --short'});` },
      }],
      registry,
      toolContext: { ...makeCtx(), toolCallLedger: new ToolCallLedger() },
      turn: 1,
      dupCalls: new Map(),
    });

    expect(codeExec.parallelSafe).toBe(true);
    expect(result.results[0]).toMatchObject({ isError: false });
    expect(result.results[0].content).toContain('git status complete');
  });

  it('exposes nested dedup refusals as structured catchable errors', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('read_file'));
    const observer = {
      beforeNestedCall: () => ({
        action: 'block' as const,
        reason: 'test-block',
        refusalKind: 'dedup',
        shouldReflect: true,
        affectsFailureStreak: false,
        sourceTool: 'read_file',
        originToolUseId: 'parent#1',
        refusalText: 'duplicate call',
        kind: 'dedup' as const,
      }),
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

  it('settles Promise.all siblings, preserves partial results, and propagates an uncaught block once', async () => {
    vi.useFakeTimers();
    try {
      const registry = new ToolRegistry();
      let editInvocations = 0;
      let siblingSettled = false;
      registry.register({
        ...noopTool('edit_file'),
        handler: async () => ok(`edit:${++editInvocations}`),
      });
      registry.register({
        ...slowTool('read_file', 0),
        parallelSafe: true,
        handler: async () => {
          await Promise.resolve();
          siblingSettled = true;
          return ok('sibling-read-result');
        },
      });
      const { buildNestedToolObserver } = await import('@mcp/code-agent/core/runner/guards/nested-observer.js');
      const observer = buildNestedToolObserver({
        failureStreaks: { streaks: new Map() },
        turn: 1,
        parentToolUseId: 'parent-refusal',
      });
      const put = vi.fn(() => 'abc123def456');

      const result = await buildCodeExecTool(registry).handler({
        code: `
          await tools.edit_file({path:'same.ts'});
          await tools.edit_file({path:'same.ts'});
          return await Promise.all([
            tools.edit_file({path:'same.ts'}),
            tools.read_file({path:'sibling.ts'})
          ]);
        `,
      }, {
        ...makeCtx(),
        currentToolUseId: 'parent-refusal',
        nestedToolObserver: observer,
        toolOutputStore: { put } as never,
      });

      expect(result.isError).toBe(true);
      expect(result.guardVerdict).toMatchObject({
        action: 'block', reason: 'mutating-repeat-blocked', originToolUseId: 'parent-refusal#3',
      });
      expect(editInvocations).toBe(2);
      expect(siblingSettled).toBe(true);
      expect(result.content).toContain('output_id:"abc123def456"');
      expect(put).toHaveBeenCalledWith(expect.stringContaining('sibling-read-result'));
      expect(result.content.match(/\[loop-refused:/g)).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
