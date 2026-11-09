import { MessageChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { newSessionId } from '@mcp/session-storage';
import { RpcResponseError, isConfirmedRpcFailure } from '@mcp/shared/rpc-response-error.js';
import { ToolRegistry } from '../../core/registry.js';
import { ToolCallLedger } from '../../core/tool-call-ledger.js';
import { previewTools, setGlobalPreviewDevtools } from '../preview/index.js';
import { browserTools } from '../browser/tools.js';
import { setGlobalResearchBrowser } from '../browser/bridge.js';
import { runBehaviorTree } from '../../core/runner/orchestrator.js';
import { makeTestContext } from '../../core/runner/nodes/__tests__/test-helpers.js';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(close => close()); setGlobalPreviewDevtools(null); setGlobalResearchBrowser(null); });
function rpc(handler: (request: unknown) => unknown | Promise<unknown>, timeoutMs = 500) {
  const { port1, port2 } = new MessageChannel();
  const caller = new MessageBridge({ port: port1, defaultTimeoutMs: timeoutMs });
  const host = new MessageBridge({ port: port2 });
  host.handle('ui', handler);
  cleanup.push(() => { caller.dispose(); host.dispose(); });
  return { invoke: (request: unknown) => caller.request('ui', request) };
}
const context = () => ({ cwd: process.cwd(), projectName: 'fixture', sessionId: newSessionId(), toolCallLedger: new ToolCallLedger() });

describe.each([
  { name: 'preview_open', tools: previewTools, install: setGlobalPreviewDevtools },
  { name: 'browser_open', tools: browserTools, install: setGlobalResearchBrowser },
])('$name host reply classification', ({ name, tools, install }) => {
  it('returns an acknowledged connection refusal without poisoning the next tool call', async () => {
    let calls = 0;
    install(rpc(async () => { if (++calls === 1) throw new Error('ERR_CONNECTION_REFUSED (-102)'); return { url: 'http://localhost:4201', windowId: 1 }; }));
    const registry = new ToolRegistry(); registry.register(tools.find(tool => tool.name === name)!);
    const ctx = context();
    const failed = await registry.invoke(name, { url: 'http://localhost:4201' }, ctx);
    expect(failed).toMatchObject({ isError: true, content: expect.stringContaining('ERR_CONNECTION_REFUSED') });
    expect(failed.effectOutcome).toBeUndefined();
    expect(ctx.toolCallLedger.outcomeUnknownTool).toBeUndefined();
    expect((await registry.invoke(name, { url: 'http://localhost:4201' }, ctx)).isError).not.toBe(true);
    expect(calls).toBe(2);
  });

  it.each(['TOOL_OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN', 'outcome_unknown', 'port_closed', 'request_timeout', 'unserializable_response'])(
    'preserves explicit downstream uncertainty: %s', async code => {
      install(rpc(async () => { throw Object.assign(new Error('downstream response lost'), { code }); }));
      const result = await tools.find(tool => tool.name === name)!.handler({ url: 'http://localhost:4201' }, context());
      expect(result.effectOutcome).toBe('unknown');
    });

  it('keeps an actual missing response distinct from a negative reply', async () => {
    install(rpc(() => new Promise(() => {}), 10));
    const result = await tools.find(tool => tool.name === name)!.handler({ url: 'http://localhost:4201' }, context());
    expect(result.effectOutcome).toBe('unknown');
  });

  it('does not propagate uncertainty into another session', async () => {
    let calls = 0;
    install(rpc(async () => {
      if (++calls === 1) throw Object.assign(new Error('response lost'), { code: 'TOOL_OUTCOME_UNKNOWN' });
      return { url: 'http://localhost:4201', windowId: 2 };
    }));
    const registry = new ToolRegistry(); registry.register(tools.find(tool => tool.name === name)!);
    const first = context(), second = context();
    expect((await registry.invoke(name, { url: 'http://localhost:4201' }, first)).effectOutcome).toBe('unknown');
    expect((await registry.invoke(name, { url: 'http://localhost:4201' }, second)).isError).not.toBe(true);
    expect(second.toolCallLedger.outcomeUnknownTool).toBeUndefined();
    // The first session's uncertain effect is still fenced, without reissuing it.
    expect((await registry.invoke(name, { url: 'http://localhost:4201' }, first)).effectOutcome).toBe('unknown');
    expect(calls).toBe(2);
  });
});

it('lets the agent receive the real preview error and finish its next turn', async () => {
  setGlobalPreviewDevtools(rpc(async () => { throw new Error('Failed to initialize Preview DevTools: ERR_CONNECTION_REFUSED (-102)'); }));
  const registry = new ToolRegistry(); registry.register(previewTools.find(tool => tool.name === 'preview_open')!);
  let calls = 0;
  const { ctx } = makeTestContext({ registry, toolContext: context(), provider: {
    name: 'fixture', model: 'fixture', setModel() {}, async *chat(request) {
      if (++calls === 1) {
        yield { type: 'tool_call_start' as const, id: 'preview', name: 'preview_open' };
        yield { type: 'tool_call_end' as const, id: 'preview', name: 'preview_open', input: { url: 'http://localhost:4201' } };
        yield { type: 'done' as const, stop_reason: 'tool_use' };
      } else {
        expect(JSON.stringify(request.messages)).toContain('ERR_CONNECTION_REFUSED');
        yield { type: 'text_delta' as const, text: 'The development server is not listening. I can inspect its configuration and continue.' };
        yield { type: 'done' as const, stop_reason: 'end_turn' };
      }
    },
  } });
  const result = await runBehaviorTree({ opts: ctx.opts, emit: ctx.emit, initialTiers: null });
  expect(result.reason).toBe('completed'); expect(calls).toBe(2);
});

it('requires transport-owned evidence, not arbitrary error text or fields', () => {
  expect(isConfirmedRpcFailure(new Error('known failure'))).toBe(false);
  expect(isConfirmedRpcFailure({ name: 'RpcResponseError', message: 'claimed receipt' })).toBe(false);
  expect(isConfirmedRpcFailure(new RpcResponseError('host rejected input'))).toBe(true);
});
