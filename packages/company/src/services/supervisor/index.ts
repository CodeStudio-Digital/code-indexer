/**
 * AgentSupervisor — public exports (Sprint 4 Phase 1).
 *
 * Hosts (e.g. `apps/http-api/server/deps.ts`) import the singleton
 * class + factory helper. Internal modules (state-machine, tracker,
 * observation) are re-exported here for tests and Phase 2 wiring.
 */
export { AgentSupervisor } from './AgentSupervisor.js';
export type {
  AgentSupervisorDeps,
  SupervisorStatus,
} from './AgentSupervisor.js';

export { HeartbeatTracker } from './heartbeat-tracker.js';
export type {
  AgentSupervisionRecord,
  TransitionResult,
  StuckAgent,
} from './heartbeat-tracker.js';

export { ObservationLayer } from './observation-layer.js';
export type { ObservationLayerDeps, IncidentEmitter } from './observation-layer.js';

// Phase 2.2 — Recovery actions
export {
  abortStuckTool,
  forceResumeSubordinate,
  resurrectMasterIfOrphaned,
  dispatchRecovery,
  listRegisteredActions,
} from './recovery-actions.js';
export type {
  RecoveryAction,
  RecoveryContext,
  RecoveryOutcome,
} from './recovery-actions.js';

// Phase 2.3 — Circuit breakers
export {
  CircuitBreakers,
  DEFAULT_BREAKER_CONFIG,
  configFromEnv,
} from './circuit-breakers.js';
export type {
  BreakerStatusSnapshot,
  CircuitBreakerConfig,
  RoleQuarantineInfo,
} from './circuit-breakers.js';

// Phase 2.4 — Persistence
export {
  NullSupervisionPersistence,
  detectGhostRunning,
} from './persistence.js';
export type {
  SupervisionPersistence,
  PersistedIncident,
  IncidentQueryRow,
} from './persistence.js';
export { SqliteSupervisionPersistence } from './persistence-sqlite.js';

// Phase 3.4 — Anomaly detection / per-tool baselines
export {
  ToolDurationBaseline,
  DEFAULT_BASELINE_CONFIG,
  baselineConfigFromEnv,
  getGlobalToolBaseline,
  setGlobalToolBaselineForTests,
} from './tool-duration-baseline.js';
export type {
  ToolBaselineConfig,
  ToolBaselineStats,
} from './tool-duration-baseline.js';

export {
  DEFAULT_STATE_TIMEOUT_MS,
  LEGAL_TRANSITIONS,
  STUCK_VARIANT_OF,
  isLegalTransition,
  isStuckState,
  isTerminalState,
  type SupervisionState,
} from './state-machine.js';

/**
 * Helper for hosts: build + return the supervisor only when the
 * `MCP_SUPERVISOR_ENABLED=1` env flag is set. Mirrors the pattern of
 * `startInboxWatchdogIfEnabled` from C8. Returns null when disabled.
 */
import type { AgentSupervisorDeps } from './AgentSupervisor.js';
import { AgentSupervisor } from './AgentSupervisor.js';

export function startAgentSupervisorIfEnabled(
  deps: AgentSupervisorDeps,
): AgentSupervisor | null {
  if (process.env.MCP_SUPERVISOR_ENABLED !== '1') return null;
  const supervisor = new AgentSupervisor(deps);
  supervisor.start();
  return supervisor;
}

export {
  setGlobalAgentSupervisor,
  getGlobalAgentSupervisor,
  clearGlobalAgentSupervisorForTests,
} from './global.js';
