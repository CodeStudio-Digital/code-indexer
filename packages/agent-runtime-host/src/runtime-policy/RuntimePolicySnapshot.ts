import type {
  ResolvedRuntimePolicyV1,
  RuntimePolicyValuesV1,
} from '@mcp/agent-runtime-contracts';
import { runtimePolicyDigest } from './RuntimePolicyCanonical.js';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** Validate the IPC clone and restore the resolver's deep-immutability seal. */
export function sealResolvedRuntimePolicyV1(
  snapshot: ResolvedRuntimePolicyV1,
): ResolvedRuntimePolicyV1 {
  if (snapshot.schemaVersion !== 1) throw new Error('unsupported runtime policy schema version');
  const values: RuntimePolicyValuesV1 = {
    productPreset: snapshot.productPreset,
    provider: snapshot.provider,
    context: snapshot.context,
    capabilities: snapshot.capabilities,
    execution: snapshot.execution,
    subagents: snapshot.subagents,
    host: snapshot.host,
    diagnostics: snapshot.diagnostics,
  };
  const digest = runtimePolicyDigest({ values, provenance: snapshot.provenance });
  if (digest !== snapshot.policyDigest) throw new Error('runtime policy digest mismatch');
  if (snapshot.policyId !== `runtime-policy-v1:${digest.slice(0, 16)}`) {
    throw new Error('runtime policy id mismatch');
  }
  return deepFreeze(snapshot);
}
