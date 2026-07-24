/**
 * Company orchestrator lookup — single API for HTTP routes / services.
 *
 * Every `CompanyOrchestrator` lives inside a dedicated worker_thread
 * managed by `WorkerOrchestratorPool`. This module hides the pool
 * behind a small, route-friendly API so consumers never need to know
 * worker_thread mechanics — they just ask for the orchestrator by
 * `companySessionId`.
 *
 * Replaces the legacy `OrchestratorRegistry` (deleted). There is no
 * in-process fallback path: if the worker file can't be resolved, the
 * server refuses to boot — see `startServer()` in `apps/http-api/server.ts`.
 */
import { getWorkerOrchestratorPool } from './workerPoolSingleton.js';
import type { CoderRunBus } from '../coder-bus.js';
import type { WorkerBackedOrchestrator } from './WorkerOrchestratorPool.js';
export type { WorkerBackedOrchestrator } from './WorkerOrchestratorPool.js';

/**
 * Lookup an orchestrator for an active session. Returns null when no
 * worker is currently spawned for the id (idle / never started / evicted).
 */
export function getCompanyOrchestrator(id: number): WorkerBackedOrchestrator | null {
  return getWorkerOrchestratorPool().get(id)?.orchestrator ?? null;
}

/** True when an active worker exists for this session id. */
export function hasCompanyOrchestrator(id: number): boolean {
  return getWorkerOrchestratorPool().has(id);
}

/**
 * Tear down the worker for this session. Fire-and-forget: pool's
 * `evict` is async but the caller doesn't need to wait — same
 * semantics as the old registry.delete which returned sync. The pool
 * also runs its own TTL sweep, so explicit eviction is mainly for
 * abort / restart flows.
 */
export function deleteCompanyOrchestrator(id: number): void {
  void getWorkerOrchestratorPool().evict(id);
}

/**
 * Gracefully evict a session and wait until its worker has exited.
 *
 * Destructive HTTP flows (abort/reset/delete) must use this awaited form so
 * they cannot report success or delete durable rows while a worker is still
 * able to write them. `deleteCompanyOrchestrator` remains the intentionally
 * fire-and-forget compatibility surface for non-blocking cleanup paths.
 */
export async function evictCompanyOrchestrator(id: number): Promise<void> {
  await getWorkerOrchestratorPool().evict(id);
}

/**
 * Spawn a worker for this session (or reuse the existing one). Returns
 * both the orchestrator proxy and the main-side mirrored bus. The
 * worker thread comes up cold; first method call awaits the boot
 * handshake via MessageBridge.
 *
 * Throws if the worker file can't be resolved — but in practice this
 * is unreachable because `startServer` refuses to boot in that state.
 */
export async function getOrSpawnCompanyOrchestrator(
  id: number,
): Promise<{ orchestrator: WorkerBackedOrchestrator; bus: CoderRunBus }> {
  return getWorkerOrchestratorPool().getOrSpawn(id);
}
