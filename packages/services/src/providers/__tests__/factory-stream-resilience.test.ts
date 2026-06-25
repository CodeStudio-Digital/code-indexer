/**
 * `createCoderProvider` wraps every coder provider with `withStreamResilience`,
 * so the benign trailing "Premature close" that node-fetch@2 throws on Node 24
 * (Electron 42) AFTER a stream already completed is swallowed — while a genuine
 * mid-stream truncation (close BEFORE `done`) still propagates.
 *
 * The provider lookup chain (registry / store / cred resolver) is mocked; the
 * REAL `withStreamResilience` from @mcp/provider-sdk runs.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ChatDelta } from '@mcp/provider-sdk';

function prematureClose(): Error {
  const e = new Error('Premature close');
  (e as { code?: string }).code = 'ERR_STREAM_PREMATURE_CLOSE';
  return e;
}

vi.mock('../registry.js', () => {
  // 'fake': full response then a benign trailing premature close (post-`done`).
  const fakeDef = {
    kind: 'fake',
    createCoder: () => ({
      name: 'fake',
      model: 'm',
      setModel() {},
      async *chat(): AsyncIterable<ChatDelta> {
        yield { type: 'text_delta', text: 'hi' };
        yield { type: 'done', stop_reason: 'stop' };
        throw prematureClose();
      },
    }),
  };
  // 'trunc': premature close BEFORE `done` = genuine truncation.
  const truncDef = {
    kind: 'trunc',
    createCoder: () => ({
      name: 'trunc',
      model: 'm',
      setModel() {},
      async *chat(): AsyncIterable<ChatDelta> {
        yield { type: 'text_delta', text: 'hi' };
        throw prematureClose();
      },
    }),
  };
  return {
    getRegistry: () => new Map([['fake', fakeDef], ['trunc', truncDef]]),
    getDefinition: () => undefined,
  };
});
vi.mock('../shared/store.js', () => ({ getStore: () => null }));
vi.mock('../shared/resolver.js', () => ({ resolveCreds: async () => ({ apiKey: 'x' }) }));

const { createCoderProvider } = await import('../factory.js');

describe('createCoderProvider — stream resilience', () => {
  it('swallows a benign premature close AFTER done', async () => {
    const provider = await createCoderProvider('fake');
    const types: string[] = [];
    for await (const d of provider.chat({} as never)) types.push(d.type);
    expect(types).toEqual(['text_delta', 'done']);
  });

  it('re-throws a genuine truncation (premature close BEFORE done)', async () => {
    const provider = await createCoderProvider('trunc');
    await expect(
      (async () => {
        for await (const _d of provider.chat({} as never)) {
          /* drain */
        }
      })(),
    ).rejects.toThrow('Premature close');
  });
});
