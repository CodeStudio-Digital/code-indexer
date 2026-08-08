import type { EngineJsonRpcTransport } from './JsonRpcPeer.js';
import type {
  OssEngineAttemptSpec,
  OssEngineRunResult,
} from './types.js';
import type { OssEngineCertificationReport } from './CertificationGate.js';

export type OssEngineRequiredLimit =
  | 'memory'
  | 'cpu_time'
  | 'wall_time'
  | 'processes'
  | 'open_handles';

export type OssEngineContainmentLevel =
  | 'hard_aggregate'
  | 'hard_process'
  | 'monitored'
  | 'unavailable';

export interface OssEngineResourceBudget {
  readonly maxMemoryBytes: bigint;
  readonly maxCpuTimeMs: bigint;
  readonly maxWallTimeMs: bigint;
  readonly maxProcesses: number;
  readonly maxOpenHandles: number;
}

export interface OssEngineProcessBinding {
  readonly candidate: OssEngineAttemptSpec['candidate'];
  readonly candidateVersion: string;
  readonly protocolVersion: string;
  readonly protocolSchemaDigest: string;
  readonly attemptId: string;
}

export interface OssEngineProcessLaunchRequest extends OssEngineProcessBinding {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  /** Complete allowlisted environment; the supervisor must not inherit Host env. */
  readonly environment: Readonly<Record<string, string>>;
  readonly resourceBudget: OssEngineResourceBudget;
  readonly requiredEnforcedLimits: readonly OssEngineRequiredLimit[];
  readonly deadlineAtUnixMs: bigint;
}

export interface OssEngineProcessLaunchReceipt extends OssEngineProcessBinding {
  readonly source: 'agentd_supervisor' | 'test_fixture' | 'direct_process';
  readonly resourceGroupId: string;
  readonly processId: number;
  readonly containmentLevel: OssEngineContainmentLevel;
  readonly processTreeOwned: boolean;
  readonly enforcedLimits: readonly OssEngineRequiredLimit[];
  readonly spawnedAt: string;
}

export interface OssEngineProcessReapReceipt extends OssEngineProcessBinding {
  readonly resourceGroupId: string;
  readonly processId: number;
  readonly treeEmpty: boolean;
  readonly exitCode?: number;
  readonly peakMemoryBytes?: bigint;
  readonly reapedAt: string;
}

export interface OssEngineProcessFinalization {
  readonly status: 'reaped' | 'ownership_retained';
  readonly disposition: 'completed' | 'interrupted' | 'failed';
  readonly reapReceipt?: OssEngineProcessReapReceipt;
  readonly reason?: string;
}

export interface OssEngineProcessLease {
  readonly launchReceipt: OssEngineProcessLaunchReceipt;
  readonly transport: EngineJsonRpcTransport;
  /**
   * Closes cooperative I/O, escalates if required, and returns only after reap
   * proof or an explicit receipt that the supervisor still owns the group.
   */
  finalize(input: {
    readonly disposition: OssEngineProcessFinalization['disposition'];
    readonly deadlineAtUnixMs: bigint;
    readonly reason?: string;
  }): Promise<OssEngineProcessFinalization>;
}

export interface OssEngineProcessSupervisorPort {
  launch(
    request: OssEngineProcessLaunchRequest,
    signal: AbortSignal,
  ): Promise<OssEngineProcessLease>;
}

export interface SupervisedOssEngineRunResult {
  readonly result: OssEngineRunResult;
  readonly certification: OssEngineCertificationReport;
  readonly launchReceipt: OssEngineProcessLaunchReceipt;
  readonly finalization: OssEngineProcessFinalization;
}
