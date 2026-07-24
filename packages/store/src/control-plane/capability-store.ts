import type DatabaseConstructor from 'better-sqlite3';
import type {
  CapabilityDescriptor,
  ResolvedCapabilitySet,
} from '@mcp/agent-runtime-contracts';
import { parseControlPlaneJson, sha256Hex, stableControlPlaneJson } from './codec.js';

type DB = InstanceType<typeof DatabaseConstructor>;

interface DescriptorRow {
  descriptor_json: string;
  descriptor_hash: string;
}

interface SetRow {
  set_json: string;
}

export class CapabilityStore {
  constructor(private readonly db: DB) {}

  /** Persists one descriptor keyed by (capabilityId, version, catalogVersion). */
  recordDescriptor(
    descriptor: CapabilityDescriptor,
    catalogVersion: string,
    recordedAt = new Date().toISOString(),
  ): void {
    const descriptorJson = stableControlPlaneJson(descriptor);
    this.db.prepare(`
      INSERT OR REPLACE INTO capability_descriptors (
        capability_id, version, catalog_version, name, source_kind,
        metadata_trust, descriptor_json, descriptor_hash, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      descriptor.capabilityId,
      descriptor.version,
      catalogVersion,
      descriptor.name,
      descriptor.source.kind,
      descriptor.source.metadataTrust,
      descriptorJson,
      sha256Hex(descriptorJson),
      recordedAt,
    );
  }

  recordDescriptors(
    descriptors: readonly CapabilityDescriptor[],
    catalogVersion: string,
    recordedAt = new Date().toISOString(),
  ): number {
    const tx = this.db.transaction((rows: readonly CapabilityDescriptor[]) => {
      for (const d of rows) this.recordDescriptor(d, catalogVersion, recordedAt);
      return rows.length;
    });
    return tx(descriptors);
  }

  getDescriptor(
    capabilityId: string,
    version: string,
    catalogVersion: string,
  ): CapabilityDescriptor | null {
    const row = this.db.prepare(`
      SELECT descriptor_json, descriptor_hash FROM capability_descriptors
      WHERE capability_id = ? AND version = ? AND catalog_version = ?
    `).get(capabilityId, version, catalogVersion) as DescriptorRow | undefined;
    return row ? parseControlPlaneJson<CapabilityDescriptor | null>(row.descriptor_json, null) : null;
  }

  /** Idempotent by content ref: the same resolved set is stored once. */
  recordResolvedSet(set: ResolvedCapabilitySet): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO resolved_capability_sets (
        ref, hash, catalog_version, agent_run_id, set_json, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      set.ref,
      set.hash,
      set.catalogVersion,
      set.agentRunId ?? null,
      stableControlPlaneJson(set),
      set.resolvedAt,
    );
  }

  getResolvedSet(ref: string): ResolvedCapabilitySet | null {
    const row = this.db.prepare(`
      SELECT set_json FROM resolved_capability_sets WHERE ref = ?
    `).get(ref) as SetRow | undefined;
    return row ? parseControlPlaneJson<ResolvedCapabilitySet | null>(row.set_json, null) : null;
  }
}
