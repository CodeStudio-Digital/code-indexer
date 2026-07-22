import type { CapabilityId } from './ids.js';

export type CapabilitySource = 'native' | 'mcp' | 'plugin' | 'host';
export type CapabilityRiskClass = 'read' | 'write' | 'execute' | 'admin';

export interface SideEffectContract {
  mutates: boolean;
  idempotency: 'none' | 'keyed' | 'naturally_idempotent';
  safeRetryStages: Array<'before_dispatch' | 'not_started_confirmed'>;
  outcomeProbe?: string;
  compensationCapabilityId?: CapabilityId;
}

export interface CapabilityDescriptor {
  capabilityId: CapabilityId;
  version: string;
  name: string;
  aliases: string[];
  source: CapabilitySource;
  provenance: string;
  defaultTier: string;
  riskClass: CapabilityRiskClass;
  requiresNetwork: boolean;
  requiresSecrets: boolean;
  inputSchemaHash: string;
  sideEffect: SideEffectContract;
  trust: 'host' | 'attested' | 'untrusted_metadata';
}

export interface ResolvedCapabilitySet {
  schemaVersion: 1;
  hash: string;
  registered: CapabilityId[];
  visible: CapabilityId[];
  eligible: CapabilityId[];
  authorized: CapabilityId[];
  descriptors: CapabilityDescriptor[];
  resolvedAt: string;
}
