import type { OssEngineAttemptSpec } from './types.js';
import type {
  OssEngineProcessBinding,
  OssEngineProcessFinalization,
  OssEngineProcessLaunchReceipt,
  OssEngineRequiredLimit,
  OssEngineResourceBudget,
} from './SupervisionTypes.js';

export const MANDATORY_SUPERVISED_LIMITS = Object.freeze([
  'memory',
  'cpu_time',
  'wall_time',
  'processes',
] as const satisfies readonly OssEngineRequiredLimit[]);

export class OssEngineSupervisionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OssEngineSupervisionError';
  }
}

export function processBinding(spec: OssEngineAttemptSpec): OssEngineProcessBinding {
  return Object.freeze({
    candidate: spec.candidate,
    candidateVersion: spec.candidateVersion,
    protocolVersion: spec.protocolVersion,
    protocolSchemaDigest: spec.protocolSchemaDigest,
    attemptId: spec.authority.attemptId,
  });
}

export function validateLaunchReceipt(
  expected: OssEngineProcessBinding,
  receipt: OssEngineProcessLaunchReceipt,
): void {
  validateBinding(expected, receipt, 'launch');
  if (receipt.resourceGroupId.trim().length === 0) {
    throw new OssEngineSupervisionError(
      'resource_group_missing',
      'Supervisor launch receipt has no resource group',
    );
  }
  if (!Number.isSafeInteger(receipt.processId) || receipt.processId <= 0) {
    throw new OssEngineSupervisionError(
      'process_id_invalid',
      `Supervisor launch receipt has invalid process ID ${receipt.processId}`,
    );
  }
  validateTimestamp(receipt.spawnedAt, 'spawned_at_invalid');
  assertUniqueLimits(receipt.enforcedLimits, 'launch_receipt_limits_duplicated');
}

export function validateFinalization(
  expected: OssEngineProcessBinding,
  launch: OssEngineProcessLaunchReceipt,
  finalization: OssEngineProcessFinalization,
): void {
  if (finalization.status === 'ownership_retained') {
    if (!finalization.reason?.trim()) {
      throw new OssEngineSupervisionError(
        'retained_ownership_reason_missing',
        'Retained process ownership requires a reason',
      );
    }
    if (finalization.reapReceipt) {
      throw new OssEngineSupervisionError(
        'retained_ownership_has_reap_receipt',
        'Retained process ownership cannot include reap evidence',
      );
    }
    return;
  }
  const reap = finalization.reapReceipt;
  if (!reap) {
    throw new OssEngineSupervisionError(
      'reap_receipt_missing',
      'Reaped finalization requires physical reap evidence',
    );
  }
  validateBinding(expected, reap, 'reap');
  if (reap.resourceGroupId !== launch.resourceGroupId || reap.processId !== launch.processId) {
    throw new OssEngineSupervisionError(
      'reap_ownership_mismatch',
      'Reap evidence does not match the launched resource group and process',
    );
  }
  if (!reap.treeEmpty) {
    throw new OssEngineSupervisionError(
      'reap_tree_not_empty',
      'A reap receipt must prove that the process tree is empty',
    );
  }
  validateTimestamp(reap.reapedAt, 'reaped_at_invalid');
}

export function hasRequiredAggregateContainment(
  receipt: OssEngineProcessLaunchReceipt,
  required: readonly OssEngineRequiredLimit[],
): boolean {
  if (receipt.source !== 'agentd_supervisor'
    || receipt.containmentLevel !== 'hard_aggregate'
    || !receipt.processTreeOwned) {
    return false;
  }
  const enforced = new Set(receipt.enforcedLimits);
  return required.every((limit) => enforced.has(limit));
}

export function validateSupervisedResourcePolicy(
  budget: OssEngineResourceBudget,
  required: readonly OssEngineRequiredLimit[],
): void {
  if (budget.maxMemoryBytes <= 0n
    || budget.maxCpuTimeMs <= 0n
    || budget.maxWallTimeMs <= 0n) {
    throw new OssEngineSupervisionError(
      'resource_budget_invalid',
      'Memory, CPU and wall-time budgets must be positive',
    );
  }
  if (!Number.isSafeInteger(budget.maxProcesses) || budget.maxProcesses < 1
    || !Number.isSafeInteger(budget.maxOpenHandles) || budget.maxOpenHandles < 1) {
    throw new OssEngineSupervisionError(
      'resource_budget_invalid',
      'Process and open-handle budgets must be positive safe integers',
    );
  }
  assertUniqueLimits(required, 'required_limits_duplicated');
  const requiredSet = new Set(required);
  if (!MANDATORY_SUPERVISED_LIMITS.every((limit) => requiredSet.has(limit))) {
    throw new OssEngineSupervisionError(
      'mandatory_supervised_limit_missing',
      `Required limits must include ${MANDATORY_SUPERVISED_LIMITS.join(', ')}`,
    );
  }
}

export function validateSupervisedEnvironment(
  environment: Readonly<Record<string, string>>,
): void {
  const names = new Set<string>();
  let encodedBytes = 0;
  for (const [name, value] of Object.entries(environment)) {
    if (name.length === 0 || name.includes('=') || name.includes('\0') || value.includes('\0')) {
      throw new OssEngineSupervisionError(
        'candidate_environment_invalid',
        `Candidate environment entry ${name || '<empty>'} is invalid`,
      );
    }
    const normalized = name.toLocaleUpperCase('en-US');
    if (names.has(normalized)) {
      throw new OssEngineSupervisionError(
        'candidate_environment_duplicate',
        `Candidate environment contains duplicate variable ${name}`,
      );
    }
    names.add(normalized);
    encodedBytes += Buffer.byteLength(name, 'utf16le')
      + Buffer.byteLength(value, 'utf16le')
      + 4;
  }
  if (encodedBytes > 64 * 1024) {
    throw new OssEngineSupervisionError(
      'candidate_environment_too_large',
      `Candidate environment uses ${encodedBytes} bytes; limit is 65536`,
    );
  }
}

function validateBinding(
  expected: OssEngineProcessBinding,
  actual: OssEngineProcessBinding,
  phase: string,
): void {
  for (const field of [
    'candidate',
    'candidateVersion',
    'protocolVersion',
    'protocolSchemaDigest',
    'attemptId',
  ] as const) {
    if (actual[field] !== expected[field]) {
      throw new OssEngineSupervisionError(
        `${phase}_binding_mismatch`,
        `${phase} receipt ${field} does not match the attempt`,
      );
    }
  }
}

function assertUniqueLimits(
  limits: readonly OssEngineRequiredLimit[],
  code: string,
): void {
  if (new Set(limits).size !== limits.length) {
    throw new OssEngineSupervisionError(code, 'Supervisor receipt contains duplicate limits');
  }
}

function validateTimestamp(value: string, code: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new OssEngineSupervisionError(code, `Invalid supervisor timestamp ${value}`);
  }
}
