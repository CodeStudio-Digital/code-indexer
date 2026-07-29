/**
 * Operator-actor audit helper for the company service routes (B3 item 6).
 *
 * The start / pause / unpause / retry / restart-dev routes run on the MAIN
 * process; the ServiceSupervisor and SandboxService (worker) write to the
 * same bundle-local transition collection through their own instances.
 *
 * Best-effort by design: an audit-trail failure must never break the
 * lifecycle operation the operator asked for.
 */
import type { ServerDeps } from '../../deps.js';

export function recordOperatorTransition(
  deps: ServerDeps,
  sessionId: string,
  serviceId: string,
  toState: string,
  reason?: string,
): void {
  try {
    deps.companyServiceTransitionsStore.record({
      sessionId,
      serviceId,
      kind: 'status',
      toState,
      reason: reason ?? null,
      actor: 'operator',
    });
  } catch (e) {
    console.warn(
      `[company-routes] operator transition ${sessionId}:${serviceId} → ${toState} failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}
