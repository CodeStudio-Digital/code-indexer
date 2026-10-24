import type { agentV1Supervisor } from '@mcp/agent-runtime-contracts';

export type HostSupervisorCommandCase =
  | 'updateAttemptAuthority'
  | 'cancelAttemptProcess'
  | 'fenceAttemptProcess'
  | 'reapAttemptProcess';

export interface PreparedSupervisorCommand {
  readonly case: HostSupervisorCommandCase;
  readonly messageId: string;
  readonly streamSeq: bigint;
  readonly sentAtUnixMs: bigint;
  readonly deadlineAtUnixMs: bigint;
  readonly payloadSha256: Uint8Array;
  readonly encoded: Uint8Array;
}

export interface PendingSupervisorCommand extends PreparedSupervisorCommand {
  readonly completion: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
  timer?: NodeJS.Timeout;
}

export type SupervisorCommandBody = Extract<
  agentV1Supervisor.ManagementPayload['body'],
  { case: HostSupervisorCommandCase }
>;
