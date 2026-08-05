import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { NativeHostBridgeCloseAuthority } from '../native/NativeHostBridgeClose.js';
import { NativeHostBridgeDuplex } from '../native/NativeHostBridgeDuplex.js';

describe('NativeHostBridgeDuplex', () => {
  it('keeps the shared sibling authority open after a clean read EOF', async () => {
    const close = vi.fn(async () => undefined);
    const stream = new NativeHostBridgeDuplex('data', authority({
      read: async () => null,
      close,
    }));

    stream.resume();
    await once(stream, 'end');

    expect(close).not.toHaveBeenCalled();
    expect(stream.destroyed).toBe(false);
    const closed = new Promise<void>((resolve) => stream.once('close', resolve));
    stream.destroy();
    await closed;
    expect(close).not.toHaveBeenCalled();
  });

  it('converts a synchronous close race into owned stream destruction', async () => {
    const close = vi.fn(async () => undefined);
    const stream = new NativeHostBridgeDuplex('control', authority({
      read: () => { throw new Error('bridge closed between scheduling and read'); },
      close,
    }));
    const error = once(stream, 'error');
    const closed = new Promise<void>((resolve) => stream.once('close', resolve));

    stream.resume();

    await expect(error).resolves.toMatchObject([
      expect.objectContaining({ message: 'bridge closed between scheduling and read' }),
    ]);
    await closed;
    expect(close).not.toHaveBeenCalled();
  });
});

function authority(overrides: {
  read: () => Promise<Uint8Array | null> | Uint8Array | null;
  close: () => Promise<void>;
}): NativeHostBridgeCloseAuthority {
  return {
    read: overrides.read,
    write: async () => undefined,
    close: overrides.close,
  } as unknown as NativeHostBridgeCloseAuthority;
}
