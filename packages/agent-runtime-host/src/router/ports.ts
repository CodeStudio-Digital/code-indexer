import type { AgentRunAttemptId } from '@mcp/agent-runtime-contracts';
import type {
  RuntimeEligibilityDecision,
  RuntimeEligibilityInput,
  RuntimeRouteCommit,
  RuntimeRouteRecord,
} from './types.js';

/**
 * The implementation must make commitIfAbsent atomic. A read followed by an
 * unconditional write is not a valid implementation of this port.
 */
export interface RuntimeRouteStorePort {
  getByAttemptId(attemptId: AgentRunAttemptId): Promise<RuntimeRouteRecord | undefined>;
  commitIfAbsent(candidate: RuntimeRouteRecord): Promise<RuntimeRouteCommit>;
}

/**
 * Eligibility implementations may consult build manifests or feature policy,
 * but must not launch runtimes or mutate product state.
 */
export interface RuntimeEligibilityPort {
  evaluate(input: RuntimeEligibilityInput): Promise<RuntimeEligibilityDecision>;
}

export interface RuntimeClockPort {
  now(): Date;
}
