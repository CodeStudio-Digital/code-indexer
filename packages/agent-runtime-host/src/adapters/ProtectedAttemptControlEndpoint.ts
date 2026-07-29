import {
  type AttemptEndpointCleanupDisposition,
  type AuthenticatedAttemptConnection,
  type AuthenticatedAttemptConnectionOwner,
  type ProtectedAttemptEndpoint,
  type ProtectedAttemptEndpointOpenExpectation,
  type ProtectedAttemptEndpointOwner,
  assertEndpointCleanupDisposition,
  consumeAuthenticatedAttemptConnection,
  consumeProtectedAttemptEndpoint,
  ownAuthenticatedAttemptConnection,
  ownProtectedAttemptEndpoint,
  revokeAuthenticatedAttemptConnection,
} from './ProtectedAttemptEndpoint.js';

export type AttemptControlCleanupDisposition =
  AttemptEndpointCleanupDisposition;
export type ProtectedAttemptControlOpenExpectation =
  ProtectedAttemptEndpointOpenExpectation;
export type ProtectedAttemptControlEndpoint =
  ProtectedAttemptEndpoint<'control'>;
export type ProtectedAttemptControlEndpointOwner =
  ProtectedAttemptEndpointOwner<'control'>;
export type AuthenticatedAttemptControlConnection =
  AuthenticatedAttemptConnection;
export type AuthenticatedAttemptControlConnectionOwner =
  AuthenticatedAttemptConnectionOwner<'control'>;

export function ownProtectedAttemptControlEndpoint(
  endpoint: ProtectedAttemptControlEndpoint,
): ProtectedAttemptControlEndpointOwner {
  return ownProtectedAttemptEndpoint('control', endpoint);
}

export function ownAuthenticatedAttemptControlConnection(
  connection: AuthenticatedAttemptControlConnection,
): AuthenticatedAttemptControlConnectionOwner {
  return ownAuthenticatedAttemptConnection('control', connection);
}

export function consumeProtectedAttemptControlEndpoint(
  owner: ProtectedAttemptControlEndpointOwner,
): ProtectedAttemptControlEndpoint {
  return consumeProtectedAttemptEndpoint('control', owner);
}

export function consumeAuthenticatedAttemptControlConnection(
  owner: AuthenticatedAttemptControlConnectionOwner,
): AuthenticatedAttemptControlConnection {
  return consumeAuthenticatedAttemptConnection('control', owner);
}

export function revokeAuthenticatedAttemptControlConnection(
  owner: AuthenticatedAttemptControlConnectionOwner,
  cause?: unknown,
): AttemptControlCleanupDisposition | undefined {
  return revokeAuthenticatedAttemptConnection('control', owner, cause);
}

export const assertCleanupDisposition =
  assertEndpointCleanupDisposition;
