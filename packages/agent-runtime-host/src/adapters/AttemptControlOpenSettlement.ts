import { awaitAuthenticatedAttemptConnection } from './AttemptEndpointOpenSettlement.js';
import {
  type AuthenticatedAttemptControlConnectionOwner,
  revokeAuthenticatedAttemptControlConnection,
} from './ProtectedAttemptControlEndpoint.js';

/**
 * Cancellation never abandons an eventual physical connection. A result that
 * settles after cancellation is revoked before it can cross the handoff.
 */
export async function awaitAuthenticatedAttemptControlConnection(
  operation: Promise<AuthenticatedAttemptControlConnectionOwner>,
  signal: AbortSignal,
): Promise<AuthenticatedAttemptControlConnectionOwner> {
  return awaitAuthenticatedAttemptConnection(
    operation,
    signal,
    revokeAuthenticatedAttemptControlConnection,
  );
}
