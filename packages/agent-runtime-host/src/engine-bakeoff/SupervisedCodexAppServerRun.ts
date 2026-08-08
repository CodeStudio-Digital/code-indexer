import { isAbsolute } from 'node:path';
import {
  BoundedJsonRpcPeer,
  type BoundedJsonRpcPeerOptions,
} from './JsonRpcPeer.js';
import {
  CodexAppServerAdapter,
  type CodexAppServerAdapterOptions,
} from './CodexAppServerAdapter.js';
import { codexAppServerArguments } from './CodexAppServerLaunch.js';
import { certifyOssEngineRun } from './CertificationGate.js';
import type {
  OssEngineAttemptSpec,
  OssEngineClockPort,
  OssEngineEventSink,
  OssEngineToolHostPort,
} from './types.js';
import { validateOssEngineAttemptSpec } from './validation.js';
import type {
  OssEngineProcessFinalization,
  OssEngineProcessLaunchRequest,
  OssEngineProcessLease,
  OssEngineProcessSupervisorPort,
  OssEngineRequiredLimit,
  OssEngineResourceBudget,
  SupervisedOssEngineRunResult,
} from './SupervisionTypes.js';
import {
  hasRequiredAggregateContainment,
  OssEngineSupervisionError,
  processBinding,
  validateFinalization,
  validateLaunchReceipt,
  validateSupervisedEnvironment,
  validateSupervisedResourcePolicy,
} from './SupervisionValidation.js';

export interface SupervisedCodexAppServerRunOptions {
  readonly supervisor: OssEngineProcessSupervisorPort;
  readonly toolHost: OssEngineToolHostPort;
  readonly executable: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly resourceBudget: OssEngineResourceBudget;
  readonly requiredEnforcedLimits: readonly OssEngineRequiredLimit[];
  readonly clientVersion: string;
  readonly expectedToolCalls?: number;
  readonly dynamicToolApiStable?: boolean;
  readonly interruptGraceMs?: number;
  readonly peer?: BoundedJsonRpcPeerOptions;
  readonly clock?: OssEngineClockPort;
}

export class SupervisedCodexAppServerRun {
  readonly #requiredLimits: readonly OssEngineRequiredLimit[];

  constructor(private readonly options: SupervisedCodexAppServerRunOptions) {
    if (!isAbsolute(options.executable)) {
      throw new OssEngineSupervisionError(
        'candidate_executable_not_absolute',
        'Supervised candidate executable must be absolute',
      );
    }
    validateSupervisedEnvironment(options.environment);
    validateSupervisedResourcePolicy(options.resourceBudget, options.requiredEnforcedLimits);
    this.#requiredLimits = Object.freeze([...options.requiredEnforcedLimits]);
  }

  async run(
    spec: OssEngineAttemptSpec,
    sink: OssEngineEventSink,
    signal: AbortSignal,
  ): Promise<SupervisedOssEngineRunResult> {
    if (spec.candidate !== 'codex_app_server') {
      throw new OssEngineSupervisionError(
        'candidate_mismatch',
        'Supervised Codex runner received another candidate',
      );
    }
    validateOssEngineAttemptSpec(spec);
    const now = this.options.clock?.now() ?? new Date();
    if (!Number.isFinite(now.getTime())) {
      throw new OssEngineSupervisionError('clock_invalid', 'Supervisor launch clock is invalid');
    }
    const nowUnixMs = BigInt(now.getTime());
    if (spec.authority.deadlineAtUnixMs <= nowUnixMs) {
      throw new OssEngineSupervisionError(
        'attempt_deadline_elapsed',
        'Attempt deadline elapsed before supervised launch',
      );
    }
    if (spec.authority.leaseExpiresAtUnixMs <= nowUnixMs) {
      throw new OssEngineSupervisionError(
        'attempt_lease_elapsed',
        'Attempt authority lease elapsed before supervised launch',
      );
    }
    const binding = processBinding(spec);
    let lease: OssEngineProcessLease | undefined;
    let result: Awaited<ReturnType<CodexAppServerAdapter['run']>> | undefined;
    let runFailure: unknown;

    try {
      lease = await this.options.supervisor.launch(this.#launchRequest(spec), signal);
      validateLaunchReceipt(binding, lease.launchReceipt);
      const peer = new BoundedJsonRpcPeer(lease.transport, this.options.peer);
      const adapterOptions: CodexAppServerAdapterOptions = {
        clientVersion: this.options.clientVersion,
        interruptGraceMs: this.options.interruptGraceMs,
        clock: this.options.clock,
      };
      result = await new CodexAppServerAdapter(peer, this.options.toolHost, adapterOptions)
        .run(spec, sink, signal);
    } catch (cause) {
      runFailure = cause;
    }

    if (!lease) {
      throw new OssEngineSupervisionError(
        'supervisor_launch_failed',
        'Supervisor did not return an engine process lease',
        runFailure,
      );
    }

    const disposition = result?.status === 'completed'
      ? 'completed'
      : result?.status === 'interrupted' || signal.aborted
        ? 'interrupted'
        : 'failed';
    let finalization: OssEngineProcessFinalization;
    try {
      finalization = await lease.finalize({
        disposition,
        deadlineAtUnixMs: spec.authority.deadlineAtUnixMs,
        ...(runFailure === undefined ? {} : { reason: errorCode(runFailure) }),
      });
      validateFinalization(binding, lease.launchReceipt, finalization);
    } catch (cause) {
      throw new OssEngineSupervisionError(
        'supervisor_finalization_failed',
        'Supervisor could not provide valid engine process finalization evidence',
        cause,
      );
    }

    if (runFailure !== undefined || !result) {
      throw new OssEngineSupervisionError(
        'candidate_run_failed',
        'Codex app-server run failed after supervised launch',
        runFailure,
      );
    }

    const reap = finalization.reapReceipt;
    const processTreeReaped = finalization.status === 'reaped' && reap?.treeEmpty === true;
    const resourceLimitsEnforced = hasRequiredAggregateContainment(
      lease.launchReceipt,
      this.#requiredLimits,
    );
    const certification = certifyOssEngineRun({
      result,
      expectedToolCalls: this.options.expectedToolCalls,
      dynamicToolApiStable: this.options.dynamicToolApiStable ?? false,
      supervisorOwned: lease.launchReceipt.source === 'agentd_supervisor',
      processTreeReaped,
      resourceLimitsEnforced,
    });
    return Object.freeze({
      result,
      certification,
      launchReceipt: lease.launchReceipt,
      finalization,
    });
  }

  #launchRequest(spec: OssEngineAttemptSpec): OssEngineProcessLaunchRequest {
    return Object.freeze({
      ...processBinding(spec),
      executable: this.options.executable,
      arguments: codexAppServerArguments(),
      workingDirectory: spec.cwd,
      environment: Object.freeze({ ...this.options.environment }),
      resourceBudget: Object.freeze({ ...this.options.resourceBudget }),
      requiredEnforcedLimits: this.#requiredLimits,
      deadlineAtUnixMs: spec.authority.deadlineAtUnixMs,
    });
  }
}

function errorCode(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string') {
    return cause.code;
  }
  return cause instanceof Error ? cause.name : 'unknown_failure';
}
