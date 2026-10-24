import { createHash, timingSafeEqual } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { agentV1Capability, agentV1Runtime, type ResolvedCapabilitySet } from '@mcp/agent-runtime-contracts';
import { deriveCapabilityDescriptor } from '../core/capability-catalog.js';
import { isExplicitlyParallelSafeRead } from '../core/policy.js';
import type { ToolRegistry } from '../core/registry.js';

/** The wire digest authenticates exactly the bytes hydrated by Rust. It is
 * distinct from the logical catalog hash, which also includes non-executable
 * skills and policy metadata. Neither may stand in for the other. */
export interface HostCapabilitySnapshot {
  readonly catalogSha256: string;
  readonly encodedSnapshot: Uint8Array;
  readonly snapshotSha256: Uint8Array;
}

export function createHostCapabilitySnapshot(registry: ToolRegistry, set: ResolvedCapabilitySet): HostCapabilitySnapshot {
  if (!registry.isSealed) throw new Error('Native capability snapshot requires a sealed registry');
  if (!/^[a-f0-9]{64}$/.test(set.hash)) throw new Error('Invalid logical capability catalog digest');
  const registered = new Set<string>(set.registered);
  const eligible = new Set<string>(set.eligible);
  const visible = new Set<string>(set.visible);
  const seen = new Set<string>();
  const tools = [...registry.list()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).flatMap((tool) => {
    const descriptor = deriveCapabilityDescriptor(tool).descriptor;
    if (!registered.has(descriptor.capabilityId) || seen.has(descriptor.capabilityId)) {
      throw new Error('Registry differs from its admitted capability catalog');
    }
    seen.add(descriptor.capabilityId);
    if (!eligible.has(descriptor.capabilityId) || !visible.has(descriptor.capabilityId)) return [];
    const encodedJsonSchema = new TextEncoder().encode(canonicalJson(descriptor.inputSchema));
    const readOnly = descriptor.execution.class === 'read' && !descriptor.execution.mutates
      && !descriptor.requirements.interactive && tool.effectBoundary === undefined && tool.riskOf === undefined;
    return [create(agentV1Runtime.ProviderToolDescriptorSchema, {
      capabilityId: descriptor.capabilityId, capabilityName: descriptor.name, capabilityVersion: descriptor.version,
      description: descriptor.description, encodedJsonSchema, schemaSha256: sha256(encodedJsonSchema),
      executionClass: agentV1Capability.CapabilityExecutionClass.HOST_CAPABILITY,
      mutates: descriptor.execution.mutates, readOnly, parallelSafe: readOnly && isExplicitlyParallelSafeRead(tool),
    })];
  });
  if (tools.length > 256) throw new Error('Native provider snapshot exceeds 256 tools');
  const encodedSnapshot = toBinary(agentV1Runtime.CapabilitySetSnapshotV1Schema,
    create(agentV1Runtime.CapabilitySetSnapshotV1Schema, { schemaVersion: 1, tools }));
  if (encodedSnapshot.length > 8 * 1024 * 1024) throw new Error('Native capability snapshot exceeds 8 MiB');
  return { catalogSha256: set.hash, encodedSnapshot, snapshotSha256: sha256(encodedSnapshot) };
}

export function resolveHostCapabilityDigest(registry: ToolRegistry, set: ResolvedCapabilitySet,
  snapshot?: HostCapabilitySnapshot): Uint8Array {
  if (!snapshot) return Uint8Array.from(Buffer.from(set.hash, 'hex'));
  const expected = createHostCapabilitySnapshot(registry, set);
  if (snapshot.catalogSha256 !== expected.catalogSha256
    || !Buffer.from(snapshot.encodedSnapshot).equals(expected.encodedSnapshot)
    || snapshot.snapshotSha256.length !== 32 || !timingSafeEqual(snapshot.snapshotSha256, expected.snapshotSha256)) {
    throw new Error('Native wire capability snapshot differs from its sealed registry');
  }
  return expected.snapshotSha256;
}

function sha256(bytes: Uint8Array): Uint8Array { return Uint8Array.from(createHash('sha256').update(bytes).digest()); }
function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .filter(([, v]) => v !== undefined).map(([k, v]) => [k, sort(v)])) : item;
  return JSON.stringify(sort(value));
}
