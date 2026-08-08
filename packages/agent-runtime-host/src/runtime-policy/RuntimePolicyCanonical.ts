import { createHash } from 'node:crypto';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function canonicalRuntimePolicyJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function runtimePolicyDigest(value: unknown): string {
  return createHash('sha256').update(canonicalRuntimePolicyJson(value)).digest('hex');
}
