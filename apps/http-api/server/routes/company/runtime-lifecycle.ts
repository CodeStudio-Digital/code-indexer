import {
  deleteCompanyOrchestrator,
  getCompanyOrchestrator,
} from '../../../sse/companyOrchestrator.js';

export type AbortCompanyRuntimeResult =
  | { ok: true }
  | { ok: false; reason: 'not_active' };

/**
 * Abort the live runtime behind a Company session.
 *
 * Route ownership is intentionally handled by the caller: the generic
 * Company control plane rejects App-owned teams, while the App facade first
 * proves the App -> Company binding and may then call this same lifecycle
 * primitive. Keeping the actual abort here prevents the two HTTP surfaces
 * from drifting.
 */
export function abortCompanyRuntime(companySessionId: number): AbortCompanyRuntimeResult {
  const orchestrator = getCompanyOrchestrator(companySessionId);
  if (!orchestrator) return { ok: false, reason: 'not_active' };
  orchestrator.abortAll();
  deleteCompanyOrchestrator(companySessionId);
  return { ok: true };
}
