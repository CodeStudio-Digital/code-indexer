import { describe, expect, it, vi } from 'vitest';
import {
  createNativeHostAttemptConnections,
} from '../native/NativeHostBridgeConnections.js';
import type {
  NativeHostAttemptChannels,
} from '../native/NativeHostBridgeBinding.js';

describe('NativeHostBridgeConnections', () => {
  it('feeds native chunks into the existing length-delimited reader', async () => {
    const fixture = nativeFixture();
    fixture.controlReads.push(
      Uint8Array.of(3, 11),
      Uint8Array.of(12, 13),
    );
    const pair = connections(fixture.channels);

    await expect(pair.control.transport.receive())
      .resolves.toEqual(Uint8Array.of(11, 12, 13));
    expect(fixture.channels.readControl).toHaveBeenCalledTimes(3);
    expect(fixture.channels.readControl).toHaveBeenCalledWith(64 * 1024);
    pair.control.transport.fail(undefined);
    await settled();
    expect(fixture.channels.close).not.toHaveBeenCalled();
    pair.authority.beginCleanup();
    await settled();
    expect(fixture.channels.close).toHaveBeenCalledOnce();
  });

  it('isolates outbound buffers and splits them at the native 64 KiB cap', async () => {
    const fixture = nativeFixture();
    const pair = connections(fixture.channels);
    const payload = new Uint8Array(70 * 1024).fill(7);

    await pair.control.transport.send(payload);

    expect(payload.every((byte) => byte === 7)).toBe(true);
    expect(fixture.controlWrites.length).toBeGreaterThan(2);
    expect(Math.max(...fixture.controlWrites.map((value) => value.byteLength)))
      .toBeLessThanOrEqual(64 * 1024);
    expect(fixture.controlWrites[0]).toEqual(Uint8Array.of(0x80, 0xb0, 0x04));
    pair.control.transport.fail(undefined);
  });

  it('keeps sibling I/O alive until the pair close authority cleans up', async () => {
    const fixture = nativeFixture();
    const pair = connections(fixture.channels);

    pair.control.transport.fail(undefined);
    await settled();

    await expect(pair.data.transport.send(Uint8Array.of(1))).resolves.toBeUndefined();
    expect(fixture.channels.close).not.toHaveBeenCalled();
    expect(pair.authority.beginCleanup()).toMatchObject({
      kind: expect.stringMatching(/closed|native_reaper/),
    });
    await settled();
    await expect(pair.data.transport.send(Uint8Array.of(1)))
      .rejects.toMatchObject({ code: 'transport_error' });
    expect(fixture.channels.close).toHaveBeenCalledOnce();
  });

  it('fails closed when native read exceeds its physical cap', async () => {
    const fixture = nativeFixture();
    fixture.controlReads.push(new Uint8Array((64 * 1024) + 1));
    const pair = connections(fixture.channels);

    await expect(pair.control.transport.receive()).rejects.toMatchObject({
      code: 'transport_error',
    });
    await settled();
    expect(fixture.channels.close).not.toHaveBeenCalled();
    pair.authority.beginCleanup();
    await settled();
    expect(fixture.channels.close).toHaveBeenCalledOnce();
  });

  it('runs explicit cleanup even after native I/O marks the owner closed', async () => {
    const fixture = nativeFixture();
    const pair = connections(fixture.channels);
    fixture.markNativeClosed();

    expect(pair.authority.beginCleanup()).toMatchObject({
      kind: 'native_reaper',
    });
    await settled();
    expect(fixture.channels.close).toHaveBeenCalledOnce();
  });
});

function connections(channels: NativeHostAttemptChannels) {
  return createNativeHostAttemptConnections(channels, {
    control: { readTimeoutMs: 1_000, writeTimeoutMs: 1_000 },
    data: { readTimeoutMs: 1_000, writeTimeoutMs: 1_000 },
  });
}

function nativeFixture(): {
  channels: NativeHostAttemptChannels;
  controlReads: Uint8Array[];
  controlWrites: Uint8Array[];
  markNativeClosed(): void;
} {
  const controlReads: Uint8Array[] = [];
  const controlWrites: Uint8Array[] = [];
  let closed = false;
  const read = async (queue: Uint8Array[]) => queue.shift() ?? null;
  const channels: NativeHostAttemptChannels = {
    controlEndpointId: 'endpoint:control',
    controlConnectionId: 'connection:control',
    controlPeerPid: 42,
    controlMaximumFrameBytes: 256 * 1024,
    dataEndpointId: 'endpoint:data',
    dataConnectionId: 'connection:data',
    dataPeerPid: 42,
    dataMaximumFrameBytes: 1024 * 1024,
    get isClosed() { return closed; },
    readControl: vi.fn(() => read(controlReads)),
    readData: vi.fn(async () => null),
    writeControl: vi.fn(async (bytes: Uint8Array) => {
      controlWrites.push(Uint8Array.from(bytes));
      bytes.fill(0);
    }),
    writeData: vi.fn(async (bytes: Uint8Array) => {
      bytes.fill(0);
    }),
    close: vi.fn(async () => {
      closed = true;
      return 'closed' as const;
    }),
  };
  return {
    channels,
    controlReads,
    controlWrites,
    markNativeClosed() { closed = true; },
  };
}

async function settled(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
