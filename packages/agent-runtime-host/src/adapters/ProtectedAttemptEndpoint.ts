import { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import { AttemptControlAdapterError } from './AttemptControlAdapterError.js';

declare const ENDPOINT_OWNER_BRAND: unique symbol;
declare const CONNECTION_OWNER_BRAND: unique symbol;

export type ProtectedAttemptEndpointKind = 'control' | 'data';

export interface ProtectedAttemptEndpointOwner<
  K extends ProtectedAttemptEndpointKind,
> {
  readonly [ENDPOINT_OWNER_BRAND]: K;
}

export interface AuthenticatedAttemptConnectionOwner<
  K extends ProtectedAttemptEndpointKind,
> {
  readonly [CONNECTION_OWNER_BRAND]: K;
}

export type AttemptEndpointCleanupDisposition =
  | { readonly kind: 'closed' }
  | {
    readonly kind: 'native_reaper';
    readonly cleanupId: string;
  };

export interface ProtectedAttemptEndpointOpenExpectation {
  readonly endpointId: string;
  readonly connectionId: string;
  readonly reservationId: string;
  readonly resourceGroupId: string;
  readonly expectedPeerPid: number;
  readonly maximumFrameBytes: number;
  readonly deadlineAtUnixMs: bigint;
  readonly signal: AbortSignal;
}

/**
 * Platform-owned endpoint. `open` resolves only after the OS proves the exact
 * local peer; addresses, tokens and native handles stay behind this boundary.
 */
export interface ProtectedAttemptEndpoint<
  K extends ProtectedAttemptEndpointKind,
> {
  open(
    expectation: ProtectedAttemptEndpointOpenExpectation,
  ): Promise<AuthenticatedAttemptConnectionOwner<K>>;
  abort(cause?: unknown): AttemptEndpointCleanupDisposition;
}

export interface AuthenticatedAttemptConnection {
  readonly endpointId: string;
  readonly connectionId: string;
  readonly peerPid: number;
  readonly transport: DelimitedByteChannel;
  handoffTransport(): DelimitedByteChannel;
  revokeBeforeHandoff(
    cause?: unknown,
  ): AttemptEndpointCleanupDisposition;
}

class EndpointOwnerValue<K extends ProtectedAttemptEndpointKind>
implements ProtectedAttemptEndpointOwner<K> {
  declare readonly [ENDPOINT_OWNER_BRAND]: K;
}

class ConnectionOwnerValue<K extends ProtectedAttemptEndpointKind>
implements AuthenticatedAttemptConnectionOwner<K> {
  declare readonly [CONNECTION_OWNER_BRAND]: K;
}

interface OwnedEndpoint {
  readonly kind: ProtectedAttemptEndpointKind;
  readonly endpoint: ProtectedAttemptEndpoint<ProtectedAttemptEndpointKind>;
}

interface OwnedConnection {
  readonly kind: ProtectedAttemptEndpointKind;
  readonly connection: AuthenticatedAttemptConnection;
}

const endpoints = new WeakMap<object, OwnedEndpoint>();
const claimedEndpoints = new WeakSet<object>();
const connections = new WeakMap<object, OwnedConnection>();
const claimedConnections = new WeakSet<object>();

export function ownProtectedAttemptEndpoint<
  K extends ProtectedAttemptEndpointKind,
>(
  kind: K,
  endpoint: ProtectedAttemptEndpoint<K>,
): ProtectedAttemptEndpointOwner<K> {
  if (
    typeof endpoint.open !== 'function'
    || typeof endpoint.abort !== 'function'
  ) throw invalidProvision('protected attempt endpoint is incomplete');
  if (claimedEndpoints.has(endpoint)) {
    throw consumed('protected attempt endpoint was already transferred');
  }
  claimedEndpoints.add(endpoint);
  const owner = Object.freeze(new EndpointOwnerValue<K>());
  endpoints.set(owner, {
    kind,
    endpoint: endpoint as ProtectedAttemptEndpoint<
      ProtectedAttemptEndpointKind
    >,
  });
  return owner;
}

export function ownAuthenticatedAttemptConnection<
  K extends ProtectedAttemptEndpointKind,
>(
  kind: K,
  connection: AuthenticatedAttemptConnection,
): AuthenticatedAttemptConnectionOwner<K> {
  if (
    typeof connection.handoffTransport !== 'function'
    || typeof connection.revokeBeforeHandoff !== 'function'
    || !(connection.transport instanceof DelimitedByteChannel)
    || !Number.isInteger(connection.peerPid)
    || connection.peerPid <= 0
  ) throw invalidProvision('authenticated attempt connection is incomplete');
  if (claimedConnections.has(connection)) {
    throw consumed('authenticated attempt connection was already transferred');
  }
  claimedConnections.add(connection);
  const owner = Object.freeze(new ConnectionOwnerValue<K>());
  connections.set(owner, {
    kind,
    connection: Object.freeze({
      endpointId: connection.endpointId,
      connectionId: connection.connectionId,
      peerPid: connection.peerPid,
      transport: connection.transport,
      handoffTransport: connection.handoffTransport.bind(connection),
      revokeBeforeHandoff:
        connection.revokeBeforeHandoff.bind(connection),
    }),
  });
  return owner;
}

export function consumeProtectedAttemptEndpoint<
  K extends ProtectedAttemptEndpointKind,
>(
  kind: K,
  owner: ProtectedAttemptEndpointOwner<K>,
): ProtectedAttemptEndpoint<K> {
  const state = endpoints.get(owner);
  if (!state || state.kind !== kind) {
    throw consumed('protected attempt endpoint owner was consumed or foreign');
  }
  endpoints.delete(owner);
  return state.endpoint as ProtectedAttemptEndpoint<K>;
}

export function consumeAuthenticatedAttemptConnection<
  K extends ProtectedAttemptEndpointKind,
>(
  kind: K,
  owner: AuthenticatedAttemptConnectionOwner<K>,
): AuthenticatedAttemptConnection {
  const state = connections.get(owner);
  if (!state || state.kind !== kind) {
    throw consumed('authenticated connection owner was consumed or foreign');
  }
  connections.delete(owner);
  return state.connection;
}

export function revokeAuthenticatedAttemptConnection<
  K extends ProtectedAttemptEndpointKind,
>(
  kind: K,
  owner: AuthenticatedAttemptConnectionOwner<K>,
  cause?: unknown,
): AttemptEndpointCleanupDisposition | undefined {
  const state = connections.get(owner);
  if (!state || state.kind !== kind) return;
  let disposition: AttemptEndpointCleanupDisposition;
  try {
    disposition = assertEndpointCleanupDisposition(
      state.connection.revokeBeforeHandoff(cause),
    );
    connections.delete(owner);
  } finally {
    try {
      state.connection.transport.fail(cause);
    } catch {
      // Preserve physical revocation as the primary cleanup attempt.
    }
  }
  return disposition;
}

export function assertEndpointCleanupDisposition(
  value: AttemptEndpointCleanupDisposition,
): AttemptEndpointCleanupDisposition {
  if (value?.kind === 'closed') return value;
  if (
    value?.kind === 'native_reaper'
    && typeof value.cleanupId === 'string'
    && value.cleanupId.length > 0
  ) return value;
  throw invalidProvision('physical endpoint cleanup lost its native owner');
}

function consumed(message: string): AttemptControlAdapterError {
  return new AttemptControlAdapterError('ownership_consumed', message);
}

function invalidProvision(message: string): AttemptControlAdapterError {
  return new AttemptControlAdapterError('invalid_provision', message);
}
