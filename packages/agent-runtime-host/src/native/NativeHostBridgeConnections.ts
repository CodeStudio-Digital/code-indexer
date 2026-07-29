import { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import type {
  AttemptEndpointCleanupDisposition,
  AuthenticatedAttemptConnection,
} from '../adapters/ProtectedAttemptEndpoint.js';
import type {
  NativeHostAttemptChannels,
} from './NativeHostBridgeBinding.js';
import {
  NativeHostBridgeCloseAuthority,
} from './NativeHostBridgeClose.js';
import {
  NATIVE_HOST_TRANSPORT_CHUNK_BYTES,
  NativeHostBridgeDuplex,
} from './NativeHostBridgeDuplex.js';

export interface NativeHostChannelTiming {
  readonly readTimeoutMs: number;
  readonly writeTimeoutMs: number;
}

export interface NativeHostAttemptConnectionPair {
  readonly authority: NativeHostBridgeCloseAuthority;
  readonly control: AuthenticatedAttemptConnection;
  readonly data: AuthenticatedAttemptConnection;
}

export function createNativeHostAttemptConnections(
  channels: NativeHostAttemptChannels,
  timing: {
    readonly control: NativeHostChannelTiming;
    readonly data: NativeHostChannelTiming;
  },
): NativeHostAttemptConnectionPair {
  const authority = new NativeHostBridgeCloseAuthority(channels);
  try {
    return Object.freeze({
      authority,
      control: connection(
        channels.controlEndpointId,
        channels.controlConnectionId,
        channels.controlPeerPid,
        channels.controlMaximumFrameBytes,
        timing.control,
        'control',
        authority,
      ),
      data: connection(
        channels.dataEndpointId,
        channels.dataConnectionId,
        channels.dataPeerPid,
        channels.dataMaximumFrameBytes,
        timing.data,
        'data',
        authority,
      ),
    });
  } catch (cause) {
    authority.beginCleanup();
    throw cause;
  }
}

function connection(
  endpointId: string,
  connectionId: string,
  peerPid: number,
  maximumFrameBytes: number,
  timing: NativeHostChannelTiming,
  kind: 'control' | 'data',
  authority: NativeHostBridgeCloseAuthority,
): AuthenticatedAttemptConnection {
  const duplex = new NativeHostBridgeDuplex(kind, authority);
  const transport = new DelimitedByteChannel(duplex, duplex, {
    maximumFrameBytes,
    maximumTransportChunkBytes: NATIVE_HOST_TRANSPORT_CHUNK_BYTES,
    readTimeoutMs: timing.readTimeoutMs,
    writeTimeoutMs: timing.writeTimeoutMs,
  });
  let transferred = false;
  return Object.freeze({
    endpointId,
    connectionId,
    peerPid,
    transport,
    handoffTransport(): DelimitedByteChannel {
      if (transferred) throw new Error(
        `native ${kind} transport was already transferred`,
      );
      transferred = true;
      return transport;
    },
    revokeBeforeHandoff(cause?: unknown): AttemptEndpointCleanupDisposition {
      if (!transferred) {
        try {
          transport.fail(cause);
        } catch {
          // Shared native cleanup remains authoritative.
        }
      }
      return authority.beginCleanup();
    },
  });
}
