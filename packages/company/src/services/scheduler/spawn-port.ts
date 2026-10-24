import type { RoleDispatchSource } from '../subordinate/role-runtime.js';
/** Minimal spawn surface the scheduler needs — satisfied by SubordinateLifecycle. */
export interface SchedulerSpawn {
  spawn(spec: {
    role: string;
    task: string;
    projectId?: number;
    dispatchSource?: RoleDispatchSource;
  }): Promise<{ agentRunId: string; coderSessionId: string }>;
}
