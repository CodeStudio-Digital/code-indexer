import type { DevOutputChunk } from '@mcp/shared';
import type { HostUiDispatchScope } from '@mcp/shared/host-ui-dispatch.js';

export interface PreviewRunnerTask {
  taskId: string;
  terminalId: string;
  projectId: number;
  status: 'running' | 'exited' | 'stopped';
  command: string;
  label: string;
}

export interface PreviewRunnerBridge {
  list(): PreviewRunnerTask[] | Promise<PreviewRunnerTask[]>;
  start(input: { projectId: number; command: string; label: string; manager: string }): Promise<PreviewRunnerTask>;
  stop(taskId: string): Promise<void>;
  detectDevCommand(projectId: number): Promise<{ command: string; label: string; manager: string } | null>;
  readBuffer(terminalId: string): DevOutputChunk[];
  pinnedPort(projectId: number): number | null;
}

/** Host-created callbacks, never deserialized from a worker's request. */
export interface PreviewDispatchScope extends HostUiDispatchScope {
  runner?: PreviewRunnerBridge;
}
