import { PassThrough } from 'node:stream';
import type {
  agentV1Common,
} from '@mcp/agent-runtime-contracts';
import { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import type {
  NativeHostAttemptChannels,
} from '../native/NativeHostBridgeBinding.js';

export function nativeBridgePeer(options: {
  readonly controlConnectionId: string;
  readonly dataConnectionId: string;
  readonly peerPid: number;
  readonly controlLimits: agentV1Common.FrameLimits;
  readonly dataLimits: agentV1Common.FrameLimits;
}) {
  const control = rawDuplex(options.controlLimits);
  const data = rawDuplex(options.dataLimits);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      control.close();
      data.close();
    }
    return 'closed' as const;
  };
  const channels: NativeHostAttemptChannels = {
    controlEndpointId: 'control',
    controlConnectionId: options.controlConnectionId,
    controlPeerPid: options.peerPid,
    controlMaximumFrameBytes: 256 * 1024,
    dataEndpointId: 'data',
    dataConnectionId: options.dataConnectionId,
    dataPeerPid: options.peerPid,
    dataMaximumFrameBytes: 1024 * 1024,
    get isClosed() { return closed; },
    readControl: (maximum) => control.read(maximum),
    readData: (maximum) => data.read(maximum),
    writeControl: (bytes) => control.write(bytes),
    writeData: (bytes) => data.write(bytes),
    close,
  };
  return {
    channels,
    control: control.peer,
    data: data.peer,
    get isClosed() { return closed; },
  };
}

function rawDuplex(limits: agentV1Common.FrameLimits) {
  const hostToPeer = new PassThrough();
  const peerToHost = new PassThrough();
  const iterator = peerToHost[Symbol.asyncIterator]();
  return {
    peer: new DelimitedByteChannel(hostToPeer, peerToHost, {
      maximumFrameBytes: Number(limits.maxFrameBytes),
      maximumTransportChunkBytes: 64 * 1024,
      readTimeoutMs: Number(limits.readTimeoutMs),
      writeTimeoutMs: Number(limits.writeTimeoutMs),
    }),
    async read(maximum: number): Promise<Uint8Array | null> {
      const next = await iterator.next();
      if (next.done) return null;
      if (
        !(next.value instanceof Uint8Array)
        || next.value.byteLength > maximum
      ) throw new Error('fake native peer chunk exceeds read cap');
      return next.value;
    },
    write(bytes: Uint8Array): Promise<void> {
      const isolated = Buffer.from(bytes);
      return new Promise<void>((resolve, reject) => {
        hostToPeer.write(isolated, (error?: Error | null) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    close(): void {
      hostToPeer.destroy();
      peerToHost.destroy();
    },
  };
}
