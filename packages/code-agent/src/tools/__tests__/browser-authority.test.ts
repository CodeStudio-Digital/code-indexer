import { afterEach, expect, it, vi } from 'vitest';
import { browserTools } from '../browser/tools.js';
import { setGlobalResearchBrowser } from '../browser/bridge.js';
import { browserDispatchArguments } from '../browser/authority.js';
import { ToolRegistry } from '../../core/registry.js';
import { ToolCallLedger } from '../../core/tool-call-ledger.js';
import type { ToolContext } from '../../core/tool.js';
import { newSessionId } from '@mcp/session-storage';

afterEach(() => setGlobalResearchBrowser(null));
const context = (): ToolContext => ({ cwd: process.cwd(), projectName: 'fixture', sessionId: newSessionId() });
const input = { url: 'https://example.com/', limit: 5, max_chars: 1000, ref: 'a1', value: 'search', key: 'Enter', full_page: true };
it.each(browserTools.map(tool => [tool.name, tool] as const))('%s uses the approved input projection', async (name, tool) => {
  const invoke = vi.fn(async () => ({ base64: 'aGVsbG8=', nodes: [] }));
  setGlobalResearchBrowser({ invoke });
  await tool.handler(input, context());
  const request = (invoke.mock.calls as any[])[0]?.[0];
  expect(request, name).toBeDefined();
  expect(JSON.parse(JSON.stringify(request.args ?? {}))).toEqual(browserDispatchArguments(name.slice(8), input));
});
it('does not admit host-only bulk cleanup', () => {
  expect(() => browserDispatchArguments('closePrefix', {})).toThrow('not an admitted tool');
});
it.each(['browser_open', 'browser_click', 'browser_fill', 'browser_press', 'browser_close'])(
  'blocks repetition when %s loses the effect response', async name => {
    const invoke = vi.fn(async () => { throw new Error('ACK lost'); });
    setGlobalResearchBrowser({ invoke });
    const registry = new ToolRegistry(); registry.register(browserTools.find(tool => tool.name === name)!);
    const ctx = { ...context(), toolCallLedger: new ToolCallLedger() };
    expect(await registry.invoke(name, input, ctx)).toMatchObject({ effectOutcome: 'unknown', error: { retryable: false } });
    expect(await registry.invoke(name, input, ctx)).toMatchObject({ effectOutcome: 'unknown' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
it('keeps read failure and cancellation before dispatch distinct from an uncertain action', async () => {
  const invoke = vi.fn(async () => { throw new Error('disconnected'); });
  setGlobalResearchBrowser({ invoke });
  const result = await browserTools.find(tool => tool.name === 'browser_extract')!.handler({}, context());
  expect(result.isError).toBe(true); expect(result.effectOutcome).toBeUndefined();
  const controller = new AbortController(); controller.abort();
  const cancelled = await browserTools[0].handler(input, { ...context(), signal: controller.signal });
  expect(cancelled.isError).toBe(true); expect(cancelled.effectOutcome).toBeUndefined();
  expect(invoke).toHaveBeenCalledTimes(1);
});
