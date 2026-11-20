/**
 * Anti-trava parte 2 — interactive tools must NOT be subject to the
 * per-invocation timeout.
 *
 * Regression: `submit_plan`/`ask_user` block in `runner.waitForUserInput()`
 * waiting for the human, but the dispatch read the raw `tool.interactive`
 * field (undefined — the flag lives in `policy.ts`) and applied the 5-min
 * default, killing the wait at exactly 300000ms. The dispatch now resolves
 * interactivity via `resolveToolMetadata` (policy), so a policy-interactive
 * tool gets no timeout even if it carries an explicit small `timeoutMs`.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { dispatchTools, type DispatchArgs } from '../executing-dispatch.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';

/** A tool whose handler blocks ~120ms but cancels cleanly on abort. */
function registryWithSlowTool(name: string, timeoutMs?: number): ToolRegistry {
  const r = new ToolRegistry();
  const tool: CoderTool = {
    name,
    description: 'slow',
    parameters: { type: 'object', properties: {} },
    source: 'native',
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    handler: async (_input, ctx) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 120);
        ctx?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
      return { content: 'DONE' };
    },
  };
  r.register(tool);
  return r;
}

const toolContext = { cwd: process.cwd(), projectName: 'test' } as ToolContext;

function args(registry: ToolRegistry, name: string): DispatchArgs {
  return { toolUses: [{ id: 't1', name, input: {} }], registry, toolContext, turn: 1 };
}

describe('dispatchTools — interactive tools are exempt from the timeout', () => {
  it('ignores a structured-cloned signal-shaped plain object', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'plain_signal',
      description: 'signal guard regression',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      handler: async (_input, ctx) => ({
        content: ctx?.signal instanceof AbortSignal ? 'LOCAL_SIGNAL' : 'NO_SIGNAL',
      }),
    });
    const malformedContext = {
      cwd: process.cwd(),
      projectName: 'test',
      signal: {},
    } as unknown as ToolContext;
    const res = await dispatchTools({
      ...args(registry, 'plain_signal'),
      toolContext: malformedContext,
    });
    expect(res.results[0]).toMatchObject({ isError: false, content: 'LOCAL_SIGNAL' });
  });

  it('times out a normal tool whose handler exceeds its timeoutMs', async () => {
    const res = await dispatchTools(args(registryWithSlowTool('foo', 30), 'foo'));
    expect(res.results[0].isError).toBe(true);
    expect(res.results[0].content).toContain('tool-timeout');
  });

  it('applies the invocation deadline while waiting for the unsafe lane', async () => {
    const registry = new ToolRegistry();
    let invoked = 0;
    registry.register({
      name: 'queued_write',
      description: 'queued write',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      mutates: true,
      parallelSafe: false,
      timeoutMs: 30,
      handler: async () => {
        invoked++;
        return { content: 'unexpected' };
      },
    });
    const ledger = new ToolCallLedger();
    const releaseOwner = await ledger.reserveUnsafe();
    const result = await dispatchTools({
      ...args(registry, 'queued_write'),
      toolContext: { ...toolContext, toolCallLedger: ledger },
    });
    expect(result.results[0]).toMatchObject({ isError: true, refusalKind: 'timeout' });
    expect(invoked).toBe(0);

    releaseOwner();
    const releaseNext = await ledger.reserveUnsafe();
    releaseNext();
  });

  it('does NOT time out a policy-interactive tool, even with a tiny timeoutMs', async () => {
    // `ask_user` is interactive via policy.BUILTIN_CLASSIFICATION. The dispatch
    // must treat it as no-timeout despite the explicit 30ms — otherwise it
    // would die at 30ms like the control above.
    const res = await dispatchTools(args(registryWithSlowTool('ask_user', 30), 'ask_user'));
    expect(res.results[0].isError).toBe(false);
    expect(res.results[0].content).toBe('DONE');
  });

  it('does NOT time out send_to_master / send_to_agent (policy-interactive, block on inboxWait)', async () => {
    for (const name of ['send_to_master', 'send_to_agent']) {
      const res = await dispatchTools(args(registryWithSlowTool(name, 30), name));
      expect(res.results[0].isError, name).toBe(false);
      expect(res.results[0].content, name).toBe('DONE');
    }
  });
});
