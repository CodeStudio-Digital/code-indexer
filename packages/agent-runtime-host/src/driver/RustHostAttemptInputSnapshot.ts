import { detachedMessage } from '../ipc/DetachedMessage.js';
import {
  agentV1Runtime,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import { scrubLaunch } from '../ipc/HostSupervisorLaunchValidation.js';
import { scrubPrepareAttempt } from './PreparedFactsScrub.js';
import type {
  RustHostAttemptRunInput,
} from './RustHostAttemptCoordinatorTypes.js';

export interface RustHostAttemptInputSnapshot {
  readonly launch: agentV1Supervisor.LaunchAttemptProcess;
  readonly prepare: agentV1Runtime.PrepareAttempt;
}

export function snapshotRustHostAttemptInput(
  input: RustHostAttemptRunInput,
): RustHostAttemptInputSnapshot {
  return {
    launch: detachedMessage(agentV1Supervisor.LaunchAttemptProcessSchema, input.launch),
    prepare: detachedMessage(agentV1Runtime.PrepareAttemptSchema, input.prepare),
  };
}

export function scrubRustHostAttemptInput(
  input: RustHostAttemptInputSnapshot,
): void {
  scrubRustHostLaunchInput(input);
  scrubRustHostPrepareInput(input);
}

export function scrubRustHostLaunchInput(
  input: RustHostAttemptInputSnapshot,
): void {
  scrubLaunch(input.launch);
}

export function scrubRustHostPrepareInput(
  input: RustHostAttemptInputSnapshot,
): void {
  scrubPrepareAttempt(input.prepare);
}
