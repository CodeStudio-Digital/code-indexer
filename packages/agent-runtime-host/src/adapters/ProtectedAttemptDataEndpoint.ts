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

export type AttemptDataCleanupDisposition =
  AttemptEndpointCleanupDisposition;
export type ProtectedAttemptDataOpenExpectation =
  ProtectedAttemptEndpointOpenExpectation;
export type ProtectedAttemptDataEndpoint =
  ProtectedAttemptEndpoint<'data'>;
export type ProtectedAttemptDataEndpointOwner =
  ProtectedAttemptEndpointOwner<'data'>;
export type AuthenticatedAttemptDataConnection =
  AuthenticatedAttemptConnection;
export type AuthenticatedAttemptDataConnectionOwner =
  AuthenticatedAttemptConnectionOwner<'data'>;

export function ownProtectedAttemptDataEndpoint(
  endpoint: ProtectedAttemptDataEndpoint,
): ProtectedAttemptDataEndpointOwner {
  return ownProtectedAttemptEndpoint('data', endpoint);
}

export function ownAuthenticatedAttemptDataConnection(
  connection: AuthenticatedAttemptDataConnection,
): AuthenticatedAttemptDataConnectionOwner {
  return ownAuthenticatedAttemptConnection('data', connection);
}

export function consumeProtectedAttemptDataEndpoint(
  owner: ProtectedAttemptDataEndpointOwner,
): ProtectedAttemptDataEndpoint {
  return consumeProtectedAttemptEndpoint('data', owner);
}

export function consumeAuthenticatedAttemptDataConnection(
  owner: AuthenticatedAttemptDataConnectionOwner,
): AuthenticatedAttemptDataConnection {
  return consumeAuthenticatedAttemptConnection('data', owner);
}

export function revokeAuthenticatedAttemptDataConnection(
  owner: AuthenticatedAttemptDataConnectionOwner,
  cause?: unknown,
): AttemptDataCleanupDisposition | undefined {
  return revokeAuthenticatedAttemptConnection('data', owner, cause);
}

export const assertDataCleanupDisposition =
  assertEndpointCleanupDisposition;
