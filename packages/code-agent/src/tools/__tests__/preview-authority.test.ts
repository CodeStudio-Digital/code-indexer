import { afterEach, expect, it, vi } from 'vitest';
import { previewTools, setGlobalPreviewDevtools } from '../preview/index.js';
import { previewDispatchArguments } from '../preview/authority.js';
import type { ToolContext } from '../../core/tool.js';

afterEach(() => setGlobalPreviewDevtools(null));
const input = { url: ' http://localhost:3000 ', selector: '#button', value: 'filled', text: 'typed', key: 'Enter',
  modifiers: ['Shift'], preset: 'mobile', width: 500, height: 600, deviceScaleFactor: 1, mobile: true,
  level: 'error', waitMs: 1, limit: 2, urlFilter: '/api', status: 200, includeBody: true, bodyMaxChars: 20,
  bodyTotalMaxChars: 40, waitForMs: 1, js: '1+1', timeoutMs: 1000, fullPage: true, kind: 'session',
  interactiveOnly: true, maxDepth: 2, x: 2, y: 3 };
it.each(previewTools.map(tool => [tool.name, tool] as const))('%s wire normalization matches the admitted input projection', async (name, tool) => {
  const invoke = vi.fn(async () => ({ base64: 'aGVsbG8=', nodes: [] }));
  setGlobalPreviewDevtools({ invoke });
  await tool.handler(input, { projectId: 7 } as ToolContext);
  const call = (invoke.mock.calls as any[])[0]?.[0];
  expect(call, name).toBeDefined();
  expect(JSON.parse(JSON.stringify(call.args ?? {}))).toEqual(previewDispatchArguments(name.slice(8), input, 7));
});
it('auto-start is bound to the owning project, ignoring unapproved wire project IDs', () => {
  expect(previewDispatchArguments('open', { projectId: 999 }, 7)).toEqual({ projectId: 7 });
});
it.each(['closeSession', 'closeSessionPrefix', 'closeWindowPrefix', 'thumbnail'])('does not admit backend-only %s', method => {
  expect(() => previewDispatchArguments(method, {}, 7)).toThrow('not an admitted tool');
});
