import type {
  ResolveRuntimePolicyInputV1,
  ResolvedFieldProvenanceV1,
  ResolvedRuntimePolicyV1,
  RuntimePolicyLayerV1,
  RuntimePolicyPatchV1,
  RuntimePolicyScalarV1,
  RuntimePolicySourceV1,
  RuntimePolicyValuesV1,
} from '@mcp/agent-runtime-contracts';
import { canonicalRuntimePolicyJson, runtimePolicyDigest } from './RuntimePolicyCanonical.js';
import {
  DEFAULT_RUNTIME_POLICY_V1,
  RUNTIME_POLICY_DEFAULT_REVISION,
} from './RuntimePolicyDefaults.js';

type PolicyLeaf = RuntimePolicyScalarV1 | readonly string[];
type Validator = (value: unknown) => boolean;

const positiveInt = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nonNegativeInt = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const nullablePositiveInt = (value: unknown): boolean => value === null || positiveInt(value);
const stringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const VALIDATORS: Readonly<Record<string, Validator>> = Object.freeze({
  productPreset: (v) => typeof v === 'string' && v.length > 0,
  'provider.firstByteTimeoutMs': positiveInt,
  'provider.idleTimeoutMs': positiveInt,
  // V1 snapshots may still carry the retired timeout. The runner ignores it.
  'provider.thinkingOnlyTimeoutMs': nonNegativeInt,
  'provider.transientRetriesPerTurn': nonNegativeInt,
  'provider.transientRetriesPerRun': nonNegativeInt,
  'provider.streamHeartbeatMs': positiveInt,
  'context.toolResultChars': positiveInt,
  'context.subagentToolResultChars': positiveInt,
  'context.unrestrictedToolResultChars': positiveInt,
  'context.unrestrictedSubagentToolResultChars': positiveInt,
  // V1 snapshots still carry the retired per-turn payload warning budget. The runner ignores it.
  'context.turnBudgetChars': positiveInt,
  // V1 snapshots still carry the retired planning cooldown. The runner ignores it.
  'context.interventionCooldownTurns': positiveInt,
  'context.compactionProfile': (v) => v === 'balanced',
  'capabilities.profile': (v) => ['auto', 'bootstrap', 'navigate', 'full'].includes(String(v)),
  'capabilities.visibleToolCap': positiveInt,
  'capabilities.disabledCapabilityNames': stringArray,
  'execution.maxTurns': nullablePositiveInt,
  'execution.maxWallMs': nullablePositiveInt,
  'execution.maxToolCalls': nullablePositiveInt,
  'execution.cancellation': (v) => v === 'cooperative_then_kill',
  'subagents.enabled': (v) => typeof v === 'boolean',
  'subagents.maxParallel': positiveInt,
  'subagents.maxDepth': nonNegativeInt,
  'host.codeExecPreset': (v) => v === 'bounded' || v === 'elevated',
  'host.workerHeapMb': (v) => positiveInt(v) && Number(v) >= 256,
  'host.workerIdleTtlMs': positiveInt,
  'host.workerPostRunLingerMs': nonNegativeInt,
  'diagnostics.traceLevel': (v) => v === 'off' || v === 'error' || v === 'verbose',
  'diagnostics.redactSensitiveValues': (v) => v === true,
  'diagnostics.sampleRate': (v) => typeof v === 'number' && v >= 0 && v <= 1,
});

function cloneDefaults(): RuntimePolicyValuesV1 {
  return JSON.parse(JSON.stringify(DEFAULT_RUNTIME_POLICY_V1)) as RuntimePolicyValuesV1;
}

function flattenPatch(patch: RuntimePolicyPatchV1): Array<[string, PolicyLeaf]> {
  const leaves: Array<[string, PolicyLeaf]> = [];
  for (const [section, value] of Object.entries(patch)) {
    if (section === 'productPreset') {
      leaves.push([section, value as PolicyLeaf]);
      continue;
    }
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      throw new Error(`runtime policy section ${section} must be an object`);
    }
    for (const [field, leaf] of Object.entries(value)) {
      leaves.push([`${section}.${field}`, leaf as PolicyLeaf]);
    }
  }
  return leaves;
}

function setLeaf(target: RuntimePolicyValuesV1, path: string, value: PolicyLeaf): void {
  const segments = path.split('.');
  if (segments.length === 1) {
    (target as unknown as Record<string, unknown>)[path] = value;
    return;
  }
  const section = (target as unknown as Record<string, Record<string, unknown>>)[segments[0]];
  section[segments[1]] = Array.isArray(value) ? [...value] : value;
}

function applyLayer(
  target: RuntimePolicyValuesV1,
  provenance: Map<string, ResolvedFieldProvenanceV1>,
  source: RuntimePolicySourceV1,
  layer: RuntimePolicyLayerV1 | undefined,
): void {
  if (!layer) return;
  if (!layer.revision.trim()) throw new Error(`runtime policy ${source} revision is required`);
  for (const [path, value] of flattenPatch(layer.values)) {
    const validator = VALIDATORS[path];
    if (!validator) throw new Error(`unknown runtime policy field: ${path}`);
    if (!validator(value)) throw new Error(`invalid runtime policy value at ${path}`);
    setLeaf(target, path, value);
    provenance.set(path, { path, value, source, sourceRevision: layer.revision });
  }
}

function defaultProvenance(values: RuntimePolicyValuesV1): Map<string, ResolvedFieldProvenanceV1> {
  const provenance = new Map<string, ResolvedFieldProvenanceV1>();
  for (const [path, value] of flattenPatch(values)) {
    provenance.set(path, {
      path,
      value,
      source: 'product_default',
      sourceRevision: RUNTIME_POLICY_DEFAULT_REVISION,
    });
  }
  return provenance;
}

function getNumber(target: RuntimePolicyValuesV1, path: string): number {
  const [section, field] = path.split('.');
  const value = field
    ? (target as unknown as Record<string, Record<string, unknown>>)[section]?.[field]
    : (target as unknown as Record<string, unknown>)[section];
  if (typeof value !== 'number') throw new Error(`runtime policy clamp target is not numeric: ${path}`);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function resolveRuntimePolicyV1(input: ResolveRuntimePolicyInputV1 = {}): ResolvedRuntimePolicyV1 {
  const values = cloneDefaults();
  const provenance = defaultProvenance(values);
  applyLayer(values, provenance, 'deployment', input.deployment);
  applyLayer(values, provenance, 'operator', input.operator);
  applyLayer(values, provenance, 'preset', input.preset);
  applyLayer(values, provenance, 'request', input.request);

  for (const clamp of input.clamps ?? []) {
    if (!VALIDATORS[clamp.path]) throw new Error(`unknown runtime policy clamp field: ${clamp.path}`);
    if (clamp.min === undefined && clamp.max === undefined) {
      throw new Error(`runtime policy clamp ${clamp.clampId} has no bound`);
    }
    const current = getNumber(values, clamp.path);
    const effective = Math.max(clamp.min ?? -Infinity, Math.min(clamp.max ?? Infinity, current));
    if (effective === current) continue;
    setLeaf(values, clamp.path, effective);
    const prior = provenance.get(clamp.path)!;
    provenance.set(clamp.path, {
      ...prior,
      value: effective,
      clampedBy: `${clamp.clampId}@${clamp.revision}`,
    });
  }

  const orderedProvenance = [...provenance.values()].sort((a, b) => a.path.localeCompare(b.path));
  const digest = runtimePolicyDigest({ values, provenance: orderedProvenance });
  const snapshot: ResolvedRuntimePolicyV1 = {
    schemaVersion: 1,
    policyId: `runtime-policy-v1:${digest.slice(0, 16)}`,
    policyDigest: digest,
    resolvedAt: input.resolvedAt ?? new Date().toISOString(),
    ...values,
    provenance: orderedProvenance,
  };
  canonicalRuntimePolicyJson(snapshot);
  return deepFreeze(snapshot);
}
