/**
 * Process-wide AgentSupervisor handle (Sprint 4 Phase 1.5).
 *
 * Mirrors the singleton pattern from `global-recent-files.ts` and
 * `global-filter.ts` (tool-selection). Hosts set the singleton at boot
 * via `setGlobalAgentSupervisor(...)`. Subordinate/master lifecycle
 * modules read it via `getGlobalAgentSupervisor()` and call
 * `registerSubordinate(...)` / `registerMaster(...)` at spawn time
 * WITHOUT needing a direct constructor injection (avoids threading
 * supervisor refs through the SubordinateLifecycle deps interface).
 *
 * Lifecycle:
 *   - Boot: `setGlobalAgentSupervisor(startAgentSupervisorIfEnabled(...))`
 *   - Spawn: `getGlobalAgentSupervisor()?.registerSubordinate({...})`
 *   - Shutdown: `setGlobalAgentSupervisor(null)` (graceful)
 *
 * Returns null when the supervisor is disabled (env flag unset).
 * Callers MUST tolerate null.
 */
import type { AgentSupervisor } from './AgentSupervisor.js';

let globalSupervisor: AgentSupervisor | null = null;

export function setGlobalAgentSupervisor(supervisor: AgentSupervisor | null): void {
  globalSupervisor = supervisor;
}

export function getGlobalAgentSupervisor(): AgentSupervisor | null {
  return globalSupervisor;
}

/** Test helper — clear the singleton between tests. */
export function clearGlobalAgentSupervisorForTests(): void {
  globalSupervisor = null;
}
