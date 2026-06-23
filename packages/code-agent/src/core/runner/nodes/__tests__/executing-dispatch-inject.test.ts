/**
 * Supervisor recovery (Phase 2.3) — `dispatchTools` must let an external
 * watcher unwedge a SINGLE stuck tool call without killing the batch. A hung
 * tool (handler never settles, ignores its abort signal) is freed by aborting
 * the registered controller; the injected message surfaces as the tool_result.
 */
import { describe, it, expect } from 'vitest';
import type { ToolContext, CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { dispatchTools } from '../executing-dispatch.js';

function emptyToolContext(): ToolContext {
  return { cwd: process.cwd(), projectName: 'test' } as ToolContext;
}

async function waitFor(pred: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('waitFor: condition never met');
}

describe('dispatchTools — supervisor inject', () => {
  it('surfaces an injected error as a stuck tool_result without aborting the batch', async () => {
    const registry = new ToolRegistry();
    // Hung tool: never settles and ignores the abort signal — models a tool
    // wedged on a network/IPC call. Only the harness AbortController can free it.
    const hang: CoderTool = {
      name: 'hang',
      description: 'never settles',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      handler: () => new Promise<ToolResult>(() => { /* hung forever */ }),
    };
    registry.register(hang);

    const controllers = new Map<string, AbortController>();
    const injected = new Map<string, string>();

    const dispatchPromise = dispatchTools({
      toolUses: [{ id: 'tu1', name: 'hang', input: {} }],
      registry,
      toolContext: emptyToolContext(),
      turn: 1,
      dupCalls: new Map(),
      registerInFlightTool: (id, ctl) => { controllers.set(id, ctl); },
      unregisterInFlightTool: (id) => { controllers.delete(id); },
      consumeInjectedToolError: (id) => {
        const m = injected.get(id);
        if (m !== undefined) injected.delete(id);
        return m;
      },
    });

    // Simulate the supervisor's injectToolResultError: stash a message, abort.
    await waitFor(() => controllers.has('tu1'));
    injected.set('tu1', '[supervisor] hang timed out — unwedged so the run can continue.');
    controllers.get('tu1')!.abort();

    const result = await dispatchPromise;
    expect(result.results).toHaveLength(1);
    expect(result.results[0].isError).toBe(true);
    expect(result.results[0].content).toContain('[supervisor]');
    expect(result.results[0].refusalKind).toBe('abort');
    // The controller was unregistered after the call settled (no leak).
    expect(controllers.has('tu1')).toBe(false);
  });

  it('falls back to the generic abort text when no message was injected', async () => {
    const registry = new ToolRegistry();
    const hang: CoderTool = {
      name: 'hang',
      description: 'never settles',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      handler: () => new Promise<ToolResult>(() => { /* hung forever */ }),
    };
    registry.register(hang);

    const controllers = new Map<string, AbortController>();
    const dispatchPromise = dispatchTools({
      toolUses: [{ id: 'tu2', name: 'hang', input: {} }],
      registry,
      toolContext: emptyToolContext(),
      turn: 1,
      dupCalls: new Map(),
      registerInFlightTool: (id, ctl) => { controllers.set(id, ctl); },
      unregisterInFlightTool: (id) => { controllers.delete(id); },
      // no consumeInjectedToolError → plain abort path
    });

    await waitFor(() => controllers.has('tu2'));
    controllers.get('tu2')!.abort();

    const result = await dispatchPromise;
    expect(result.results[0].isError).toBe(true);
    expect(result.results[0].content).toContain('cancelled by user/session');
  });
});
