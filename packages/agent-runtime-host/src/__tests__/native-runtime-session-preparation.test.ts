import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeDurableEngineEventCommitter } from '../native/NativeDurableEngineEventCommitter.js';
import { prepareNativeRuntimeSession } from '../native/NativeRuntimeSessionPreparation.js';
import type { NativeRustHostAttemptRuntimeOptions } from '../native/NativeRustHostAttemptRuntimeTypes.js';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const close = vi.fn(async () => undefined);
  const store = { close } as unknown as NativeDurableEngineEventCommitter;
  const open = vi.spyOn(NativeDurableEngineEventCommitter, 'open').mockResolvedValue(store);
  let now = 1_000n;
  const options = { binding: {}, sessionStore: {}, data: {},
    supervisor: { expectedConnectionId: 'preparation', nowUnixMs: () => now },
    openDeadlineAtUnixMs: 31_000n,
  } as unknown as NativeRustHostAttemptRuntimeOptions;
  return { options, store, open, close, setNow(value: bigint) { now = value; } };
}

describe('native pre-spawn session preparation', () => {
  it('retains the original opening deadline after slow recovery and durable attachment work', async () => {
    const f = fixture();
    f.open.mockImplementation(async () => { f.setNow(12_000n); return f.store; });
    let committed = false;
    const prepared = await prepareNativeRuntimeSession({ ...f.options, sessionStoreReady: async store => {
      expect(store).toBe(f.store);
      f.setNow(24_000n);
      committed = true;
    } });
    expect(committed).toBe(true);
    expect(prepared.sessionStore).toBe(f.store);
    expect(f.options.openDeadlineAtUnixMs).toBe(31_000n);
    expect(f.close).not.toHaveBeenCalled();
  });

  it('closes recovered authority if attachment preparation fails', async () => {
    const f = fixture();
    await expect(prepareNativeRuntimeSession({ ...f.options, sessionStoreReady: async () => {
      throw new Error('attachment unavailable');
    } })).rejects.toThrow('attachment unavailable');
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('does not persist attachments after cancellation while opening the writer', async () => {
    const f = fixture();
    const abort = new AbortController();
    f.open.mockImplementation(async () => { abort.abort(new Error('cancel recovery')); return f.store; });
    const sessionStoreReady = vi.fn();
    await expect(prepareNativeRuntimeSession({ ...f.options, sessionStoreReady }, abort.signal))
      .rejects.toThrow('cancel recovery');
    expect(sessionStoreReady).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('rejects expiration during preparation and releases the writer', async () => {
    const f = fixture();
    await expect(prepareNativeRuntimeSession({ ...f.options, sessionStoreReady: () => f.setNow(31_000n) }))
      .rejects.toThrow('opening authority expired during preparation');
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('rejects competing writer authorities before opening either', async () => {
    const f = fixture();
    await expect(prepareNativeRuntimeSession({ ...f.options,
      data: { ...f.options.data, engineEventCommitter: f.store },
    })).rejects.toThrow('authority is ambiguous');
    expect(f.open).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });
});
