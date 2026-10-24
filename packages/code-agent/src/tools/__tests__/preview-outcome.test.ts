import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../core/registry.js';
import { ToolCallLedger } from '../../core/tool-call-ledger.js';
import type { ToolContext } from '../../core/tool.js';
import { newSessionId } from '@mcp/session-storage';
import { previewTools, setGlobalPreviewDevtools } from '../preview/index.js';

afterEach(() => setGlobalPreviewDevtools(null));
const context = (extra: Partial<ToolContext> = {}): ToolContext => ({ cwd: process.cwd(), projectName: 'fixture', sessionId: newSessionId(), ...extra });
const get = (name: string) => previewTools.find(tool => tool.name === name)!;

describe('preview outcome confirmation', () => {
  it.each(['preview_click', 'preview_fill', 'preview_type', 'preview_press', 'preview_eval', 'preview_scroll',
    'preview_hover', 'preview_double_click', 'preview_right_click', 'preview_viewport', 'preview_close'])(
    'preserves uncertainty after dispatched %s loses its response', async name => {
      setGlobalPreviewDevtools({ invoke: async () => { throw new Error('response lost'); } });
      const result = await get(name).handler({ selector: 'ref=a1', value: 'fixture', text: 'fixture', key: 'Enter', expression: '1' }, context());
      expect(result).toMatchObject({ isError: true, effectOutcome: 'unknown', error: { retryable: false } });
    });

  it('blocks a second effect after a click response is lost', async () => {
    let clicks = 0;
    setGlobalPreviewDevtools({ invoke: async () => { clicks++; throw new Error('ACK lost'); } });
    const registry = new ToolRegistry(); registry.register(get('preview_click'));
    const ctx = context({ toolCallLedger: new ToolCallLedger() });
    expect(await registry.invoke('preview_click', { selector: 'ref=a1' }, ctx)).toMatchObject({ effectOutcome: 'unknown' });
    expect(await registry.invoke('preview_click', { selector: 'ref=a1' }, ctx)).toMatchObject({ effectOutcome: 'unknown' });
    expect(clicks).toBe(1);
  });

  it('keeps a read failure distinct from an uncertain effect', async () => {
    setGlobalPreviewDevtools({ invoke: async () => { throw new Error('read failed'); } });
    const result = await get('preview_console').handler({}, context());
    expect(result.isError).toBe(true); expect(result.effectOutcome).toBeUndefined();
  });

  it('does not label a pre-dispatch cancellation as an executed effect', async () => {
    const controller = new AbortController(); controller.abort();
    const invoke = vi.fn(); setGlobalPreviewDevtools({ invoke });
    const result = await get('preview_click').handler({ selector: 'ref=a1' }, context({ signal: controller.signal }));
    expect(result.isError).toBe(true); expect(result.effectOutcome).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});
