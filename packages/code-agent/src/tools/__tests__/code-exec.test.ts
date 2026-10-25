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
import {
  buildCodeExecTool,
  _exposedToolNames,
  _maxParallelToolCalls,
} from '@mcp/code-agent/tools/code-exec.js';
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
  it('rejects a lexical tools shadow before starting any nested call', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => ok('skeleton'));
    registry.register({
      ...noopTool('mcp__get_file_skeleton'),
      mutates: false,
      parallelSafe: true,
      handler,
    });

    const res = await buildCodeExecTool(registry).handler({
      code: `const [author, tools, findings] = await Promise.all([
        mcp__get_file_skeleton({file_path:'Editor/Timeline/TimelineAuthor.cs'}),
        Promise.resolve([]),
        tools.mcp__get_file_skeleton({file_path:'Tests/TimelineAuthorTests.cs'})
      ]); return {author, tools, findings};`,
    }, makeCtx());

    expect(res.isError).toBe(true);
    expect(res.content).toContain("Identifier 'tools' has already been declared");
    expect(res.content).toContain('reserved code_exec tool proxy');
    expect(res.content).toContain('toolResults');
    expect(handler).not.toHaveBeenCalled();
  });

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

  it('keeps goal lifecycle tools on the direct top-level audit path', () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('create_goal'));
    registry.register(noopTool('get_goal'));
    registry.register(noopTool('update_goal'));

    const exposed = _exposedToolNames(registry);
    expect(exposed).not.toContain('create_goal');
    expect(exposed).not.toContain('get_goal');
    expect(exposed).not.toContain('update_goal');
  });
});

describe('code_exec console output limits', () => {
  it('elides excess console output without aborting the structured return', async () => {
    const registry = new ToolRegistry();
    const codeExec = buildCodeExecTool(registry);
    const put = vi.fn(() => 'must-not-be-used');

    const res = await codeExec.handler(
      {
        code: `
          console.log('x'.repeat(49_980));
          console.log('discard-me'.repeat(100));
          console.error('CRITICAL_DIAGNOSTIC_AFTER_LOG_CAP');
          return { status: 'done', important: 'structured-return-survived' };
        `,
      },
      {
        ...makeCtx(),
        toolOutputStore: { put } as never,
      },
    );

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('console_truncated=2 line(s)');
    expect(res.content).toContain('CRITICAL_DIAGNOSTIC_AFTER_LOG_CAP');
    expect(res.content).toContain('[return]');
    expect(res.content).toContain('structured-return-survived');
    expect(res.content).not.toContain('output cap (50000 bytes) exceeded');
    expect(res.sourceTruncations).toEqual([
      expect.objectContaining({
        technique: 'bounded-console-cap',
        unit: 'bytes',
        recoverable: false,
      }),
    ]);
    expect(res.sourceTruncations![0]!.inputSize).toBeGreaterThan(
      res.sourceTruncations![0]!.outputSize,
    );
    expect(res.sourceTruncations![0]!.outputId).toBeUndefined();
    expect(put).not.toHaveBeenCalled();
  });

  it('passes a large return intact to the central runner finalizer', async () => {
    const registry = new ToolRegistry();
    const codeExec = buildCodeExecTool(registry);
    const middle = 'MIDDLE-SENTINEL';
    const payload = `BEGIN-${'a'.repeat(30_000)}${middle}${'z'.repeat(30_000)}-TAIL`;

    const res = await codeExec.handler(
      { code: `return ${JSON.stringify(payload)};` },
      makeCtx(),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content.length).toBeGreaterThan(50_000);
    expect(res.content).toContain('BEGIN-');
    expect(res.content).toContain(middle);
    expect(res.content).toContain('-TAIL');
    expect(res.content).not.toContain('[truncated: output_id=');
  });

  it('surfaces the real script failure after noisy logs', async () => {
    const registry = new ToolRegistry();
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      {
        code: `
          console.log('x'.repeat(60_000));
          throw new Error('REAL_SCRIPT_FAILURE_AFTER_LOG_CAP');
        `,
      },
      makeCtx(),
    );

    expect(res.isError).toBe(true);
    expect(res.content).toContain('REAL_SCRIPT_FAILURE_AFTER_LOG_CAP');
    expect(res.content).toContain('[logs truncated: 1 line(s), 60001 byte(s)');
    expect(res.content).not.toContain('output cap (50000 bytes) exceeded');
    expect(res.sourceTruncations).toEqual([
      expect.objectContaining({ technique: 'bounded-console-cap', recoverable: false }),
    ]);
  });
});

describe('code_exec structured tool compatibility', () => {
  it('returns compact JSON from structuredData while direct callers receive markdown', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'structured_read',
      description: 'structured',
      source: 'native',
      mutates: false,
      parallelSafe: true,
      parameters: { type: 'object', properties: {} },
      handler: async () => ({
        content: '# Result\n\n- id: 7',
        contentFormat: 'markdown',
        structuredData: { id: 7, status: 'ok' },
      }),
    });
    const direct = await registry.invoke('structured_read', {}, makeCtx());
    expect(direct.content).toContain('# Result');

    const result = await buildCodeExecTool(registry).handler({
      code: 'const raw = await tools.structured_read({}); const parsed = JSON.parse(raw); return parsed;',
    }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('"id": 7');
    expect(result.content).toContain('"status": "ok"');
  });

  it('forwards allowlisted structured recovery ids to the nested-call ledger', async () => {
    const workflowId = 'wf-nested-private';
    const registry = new ToolRegistry();
    registry.register({
      name: 'workflow',
      description: 'structured workflow',
      source: 'native',
      mutates: true,
      parameters: { type: 'object', properties: {} },
      handler: async () => ({
        content: 'workflow completed',
        structuredData: {
          kind: 'workflow_result',
          status: 'completed',
          workflowId,
        },
      }),
    });
    const ledger = new ToolCallLedger();
    const result = await buildCodeExecTool(registry).handler({
      code: 'return await tools.workflow({});',
    }, { ...makeCtx(), toolCallLedger: ledger });

    expect(result.isError).toBeFalsy();
    expect(ledger.snapshot()[0]?.recoveryOperationId).toMatch(/^workflow:/);
    expect(JSON.stringify(ledger.snapshot())).not.toContain(workflowId);
  });

  it('keeps an explicitly optional probe from aborting its Promise.all siblings', async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...slowTool('read_file', 1),
      parallelSafe: true,
    });
    registry.register({
      name: 'mcp__get_symbol_body',
      description: 'symbol probe',
      source: 'mcp',
      mutates: false,
      parallelSafe: true,
      parameters: { type: 'object', properties: {} },
      handler: async () => ({
        content: '[SYMBOL_NOT_FOUND] Symbol "buildAnnotations" not found. Use get_file_skeleton.',
        isError: true,
      }),
    });

    const result = await buildCodeExecTool(registry).handler({
      code: `
        const [file, symbol] = await Promise.all([
          tools.read_file({}),
          attempt(tools.mcp__get_symbol_body({symbol_name:'buildAnnotations'}))
        ]);
        return { file, symbol };
      `,
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('read_file-done');
    expect(result.content).toContain('"ok": false');
    expect(result.content).toContain('"code": "SYMBOL_NOT_FOUND"');
    expect(result.content).toContain('"kind": "not_found"');
    expect(result.content).toContain('get_file_skeleton');
  });

  it('does not let attempt downgrade a timeout into a best-effort result', async () => {
    const registry = new ToolRegistry();
    registry.register(hangTool('probe', 20));

    const result = await buildCodeExecTool(registry).handler({
      code: `return await attempt(tools.probe({}));`,
    }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.error).toMatchObject({ code: 'TOOL_TIMEOUT', kind: 'timeout' });
    expect(result.content).toContain('nested call summary');
    expect(result.content).toContain('failed=1');
  });

  it('does not let attempt hide a plan-mode refusal', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('edit_file'));

    const result = await buildCodeExecTool(registry).handler({
      code: `return await attempt(tools.edit_file({path:'blocked.ts'}));`,
    }, {
      ...makeCtx(),
      runner: {
        isPlanApproved: () => false,
        currentTaskScopeId: () => null,
        currentTaskScopeFiles: () => null,
        opts: { planMode: true },
      } as never,
    });

    expect(result.isError).toBe(true);
    expect(result.error).toMatchObject({ code: 'TOOL_CALL_REFUSED', kind: 'refusal' });
    expect(result.guardVerdict).toMatchObject({ action: 'block', reason: 'policy-gate' });
    expect(result.content).toContain('refused=1');
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
  it('carries nested producer truncation metadata into the observer audit event', async () => {
    const sourceTruncations = [{
      technique: 'nested-page-limit',
      inputSize: 20,
      outputSize: 10,
      unit: 'items' as const,
      recoverable: true,
    }];
    const registry = new ToolRegistry();
    registry.register({
      ...noopTool('read_file'),
      handler: async () => ({ content: 'nested page', sourceTruncations }),
    });
    const events: Array<{ sourceTruncations?: unknown }> = [];

    const result = await buildCodeExecTool(registry).handler(
      { code: `return await tools.read_file({ path: 'a.ts' });` },
      {
        ...makeCtx(),
        nestedToolObserver: {
          beforeNestedCall: () => null,
          afterNestedCall: (event) => events.push(event),
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(events).toHaveLength(1);
    expect(events[0]!.sourceTruncations).toEqual(sourceTruncations);
  });

  it('executes ten authorized mutations without an arbitrary repetition cutoff', async () => {
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

    expect(res.isError).toBeFalsy();
    expect(res.content).not.toContain('[loop-refused');
    expect(res.content).toContain('finished all 10');
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

  it('a session-local mutating transition invalidates nested stable reuse', async () => {
    const registry = new ToolRegistry();
    let version = 0;
    let reads = 0;
    registry.register({
      ...stableRead(async () => ok(`version:${version}:read:${++reads}`)),
      name: 'get_session_state',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    });
    registry.register({
      name: 'update_session_state',
      description: 'session-local state transition',
      source: 'native',
      mutates: false,
      riskLevel: 'read',
      repeatPolicy: 'mutating',
      executionClass: 'read',
      parallelSafe: false,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        version += 1;
        return ok('updated');
      },
    });

    const result = await buildCodeExecTool(registry).handler({
      code: `
        const before = await tools.get_session_state({});
        await tools.update_session_state({});
        const after = await tools.get_session_state({});
        return {before, after};
      `,
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(reads).toBe(2);
    expect(result.content).toContain('version:0');
    expect(result.content).toContain('version:1');
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
    expect(result.isError).toBeFalsy();
    for (const path of ['component.ts', 'template.html', 'spec.ts', 'service.php']) {
      expect(result.content).toContain(`result:${path}`);
    }
  });
});

describe('code_exec metadata safety and scheduling', () => {
  it('records input-sensitive database risk for nested SELECT and INSERT calls', async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...noopTool('db_query'),
      mutates: false,
      riskLevel: 'read',
      executionClass: 'read',
      riskOf: (input) => /^\s*select\b/i.test(
        String((input as { sql?: unknown } | null)?.sql ?? ''),
      ) ? 'read' : 'write',
      handler: async () => ok('query complete'),
    });
    const ledger = new ToolCallLedger();
    const result = await buildCodeExecTool(registry).handler({
      code: `
        await tools.db_query({sql:'SELECT * FROM sessions'});
        await tools.db_query({sql:'INSERT INTO sessions(id) VALUES (1)'});
        return 'done';
      `,
    }, { ...makeCtx(), toolCallLedger: ledger });

    expect(result.isError).toBeFalsy();
    const entries = ledger.snapshot();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      mutates: false,
      riskLevel: 'read',
      executionClass: 'read',
    });
    expect(entries[1]).toMatchObject({
      mutates: true,
      riskLevel: 'write',
      executionClass: 'write',
    });
  });

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

  it('keeps invocation ids stable when parallel siblings finish out of order', async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...noopTool('run_command'),
      mutates: false,
      parallelSafe: true,
      repeatPolicy: 'volatile',
      executionClass: 'execute',
      handler: async (args) => {
        if (args.command === 'slow') await sleep(20);
        return ok(String(args.command));
      },
    });
    const settled: Array<{ invocationId: string; resultPreview: string }> = [];
    const observer: NonNullable<ToolContext['nestedToolObserver']> = {
      beforeNestedCall: (_name, args, opts) => args.command === 'blocked'
        ? {
            action: 'block',
            reason: 'test-block',
            refusalKind: 'dedup',
            shouldReflect: true,
            affectsFailureStreak: false,
            originToolUseId: opts?.originToolUseId,
            refusalText: 'blocked immediately',
            kind: 'dedup',
          }
        : null,
      afterNestedCall: (entry) => {
        settled.push({
          invocationId: entry.invocationId,
          resultPreview: entry.resultPreview,
        });
      },
    };

    const result = await buildCodeExecTool(registry).handler({
      code: `return await Promise.all([
        tools.run_command({command:'slow'}),
        (async () => {
          try { return await tools.run_command({command:'blocked'}); }
          catch (error) { return String(error); }
        })()
      ]);`,
    }, {
      ...makeCtx(),
      currentToolUseId: 'parent-order',
      nestedToolObserver: observer,
    });

    expect(result.isError).toBeFalsy();
    expect(settled.map((entry) => entry.invocationId)).toEqual([
      'parent-order#2',
      'parent-order#1',
    ]);
    expect(new Set(settled.map((entry) => entry.invocationId)).size).toBe(2);
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
      // Exercise the explicit policy-block contract independently of repetition.
      const observer: NonNullable<ToolContext['nestedToolObserver']> = {
        beforeNestedCall: (name, _args, opts) => name === 'edit_file' && editInvocations === 2
          ? { action: 'block', reason: 'policy-gate', refusalKind: 'gate',
              shouldReflect: true, affectsFailureStreak: false, originToolUseId: opts?.originToolUseId, refusalText: 'policy denied' }
          : null,
        afterNestedCall: () => {},
      };
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
        action: 'block', reason: 'policy-gate', originToolUseId: 'parent-refusal#3',
      });
      expect(editInvocations).toBe(2);
      expect(siblingSettled).toBe(true);
      expect(result.content).toContain('output_id:"abc123def456"');
      expect(put).toHaveBeenCalledWith(expect.stringContaining('sibling-read-result'));
      expect(result.content).toContain('nested call summary');
      expect(result.content).toContain('succeeded=3');
      expect(result.content).toContain('refused=1');
      expect(result.structuredData).toMatchObject({
        kind: 'code_exec_failure',
        nested: { summary: { total: 4, succeeded: 3, refused: 1 } },
      });
      expect(result.content).toContain('policy denied');
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

  it('bounds Promise.all fan-out while preserving parallel-safe overlap and results', async () => {
    const registry = new ToolRegistry();
    let active = 0;
    let maxActive = 0;
    registry.register({
      ...slowTool('read_file', 1),
      parallelSafe: true,
      handler: async (args) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(20);
        active--;
        return ok(`read:${String(args.n)}`);
      },
    });
    // Mirrors the reported batch: 8 prepare_edit + glob + read + 5 RAG calls.
    const values = Array.from({ length: 15 }, (_, index) => index + 1);
    const result = await buildCodeExecTool(registry).handler({
      code: `return await Promise.all([${values
        .map((n) => `tools.read_file({n:${n}})`)
        .join(',')}]);`,
    }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(maxActive).toBe(Math.min(_maxParallelToolCalls, values.length));
    expect(maxActive).toBeGreaterThan(1);
    for (const n of values) expect(result.content).toContain(`read:${n}`);
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

  it('times out a queued unsafe call before lane acquisition', async () => {
    const registry = new ToolRegistry();
    let physicalInvocations = 0;
    registry.register({
      ...noopTool('run_command'),
      mutates: true,
      parallelSafe: false,
      resolveTimeoutMs: (args) => Number(args.timeout_ms),
      handler: () => {
        physicalInvocations++;
        return new Promise<never>(() => {}); // deliberately ignores cancellation
      },
    });
    const started = Date.now();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.prependListener('unhandledRejection', onUnhandled);
    let result;
    try {
      result = await buildCodeExecTool(registry).handler({
        code: `return await Promise.all([
          tools.run_command({command:'first', timeout_ms:80}),
          tools.run_command({command:'second', timeout_ms:30})
        ]);`,
      }, makeCtx());
      await sleep(20);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }

    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out after 30 ms');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(physicalInvocations).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it('does not leak sibling rejections when an excluded control tool ends a Promise.all batch', async () => {
    const registry = new ToolRegistry();
    const invoked: string[] = [];
    registry.register({
      ...noopTool('run_command'),
      mutates: true,
      parallelSafe: false,
      handler: async (args) => {
        const command = String((args as { command?: unknown }).command ?? '');
        invoked.push(command);
        await sleep(5);
        return ok(`${command} completed`);
      },
    });
    registry.register(noopTool('task_list'));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.prependListener('unhandledRejection', onUnhandled);
    let result;
    try {
      result = await buildCodeExecTool(registry).handler({
        code: `const values = await Promise.all([
          attempt(tools.run_command({command:'optional-probe'})),
          tools.run_command({command:'required-read'}),
          tools.run_command({command:'queued-one'}),
          task_list({gate:'track', updates:[]})
        ]);
        return values;`,
      }, makeCtx());
      await sleep(20);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }

    expect(result.isError).toBe(true);
    expect(result.content).toContain('task_list is not defined');
    expect(result.content).toContain('top-level tool call');
    expect(invoked).not.toContain('task_list');
    expect(unhandled).toEqual([]);
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
    expect(res.content).toContain('attempt(...)');
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

  it('list_tools() reports a runtime plugin tier instead of bootstrap fallback', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('plugin__cloudflare__deploy_worker'));
    const codeExec = buildCodeExecTool(
      registry,
      new Map([['plugin__cloudflare__deploy_worker', 'plugin:cloudflare']]),
    );

    const res = await codeExec.handler(
      { code: `return JSON.stringify(list_tools());` },
      makeCtx(),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('"name":"plugin__cloudflare__deploy_worker"');
    expect(res.content).toContain('"tier":"plugin:cloudflare"');
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
    expect(res.content).toContain('"callableInsideCodeExec":true');
    expect(res.content).toContain('"invokeAs":"code_exec"');
  });

  it('tool_schema introspects a sandbox-excluded control tool without exposing it', async () => {
    const registry = new ToolRegistry();
    registry.register(noopTool('read_file'));
    registry.register(noopTool('decision_gate')); // interactive via resolved policy metadata
    const codeExec = buildCodeExecTool(registry);

    const res = await codeExec.handler(
      { code: `return JSON.stringify(tool_schema('decision_gate'));` },
      makeCtx(),
    );

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('"name":"decision_gate"');
    expect(res.content).toContain('"schema"');
    expect(res.content).toContain('"callableInsideCodeExec":false');
    expect(res.content).toContain('"invokeAs":"top_level"');
    expect(_exposedToolNames(registry)).not.toContain('decision_gate');

    const nestedCall = await codeExec.handler(
      { code: `return await tools.decision_gate({ questions: [] });` },
      makeCtx(),
    );
    expect(nestedCall.isError).toBe(true);
    expect(nestedCall.content).toContain('decision_gate is not an available tool in this code_exec');
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
