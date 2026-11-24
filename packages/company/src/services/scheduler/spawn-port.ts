import type { SpawnSubordinateSpec } from '../subordinate/spec.js';
/** Minimal spawn surface the scheduler needs — satisfied by SubordinateLifecycle. */
export interface SchedulerSpawn {
  spawn(spec: SpawnSubordinateSpec): Promise<{ agentRunId: string; coderSessionId: string }>;
}
