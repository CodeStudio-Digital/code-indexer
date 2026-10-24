import type { AgentRunAttemptId } from '@mcp/agent-runtime-contracts';
import type {
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

export interface RuntimeClockPort {
  now(): Date;
}
