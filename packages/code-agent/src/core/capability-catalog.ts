/**
 * Capability Catalog adapter (Fase 2 — 2A).
 *
 * Derives a `CapabilityDescriptor` (doc 14 §8) from each registered
 * `CoderTool` and resolves a `ResolvedCapabilitySet` + hash for one AgentRun.
 *
 * Two invariants drive every mapping:
 *   1. Derivation is TOTAL — every tool yields a descriptor + tier, with a
 *      conservative default when metadata is absent. A descriptor never goes
 *      missing because of classification; only a genuine registration bug
 *      (no name/source) makes a tool indescribable.
 *   2. External metadata is UNTRUSTED — `mcp_external`/`plugin`/`remote`
 *      declarations never REDUCE the locally-classified mutation, risk,
 *      network or secret posture (14:513-516). Only a locally-versioned
 *      attestation may relax the conservative stance.
 *
 * Authorization is intentionally NOT part of this module — allow/deny/ask
 * belongs to the Policy Engine (D-005).
 */
import { createHash } from 'node:crypto';
import type {
  CapabilityDescriptor,
  CapabilityExecution,
  CapabilityRequirements,
  CapabilitySource,
  CapabilityVisibility,
  ProviderCapabilityProjection,
  ResolvedCapabilitySet,
  SideEffectContract,
} from '@mcp/agent-runtime-contracts';
import type { AgentRunId, CapabilityId } from '@mcp/agent-runtime-contracts';
import type { CoderTool } from './tool.js';
import type { ResolvedSkill } from '../skills/types.js';
import { resolveToolMetadata } from './policy.js';
import { sanitizeUntrustedCapabilityMetadata } from '@mcp/shared';
export { sanitizeUntrustedCapabilityMetadata } from '@mcp/shared';

function asCapabilityId(value: string): CapabilityId {
  return value as CapabilityId;
}

export interface CapabilityProvenance {
  /** Overrides the source.kind derivation (e.g. 'plugin', 'skill', 'remote'). */
  sourceKind?: CapabilitySource['kind'];
  providerId?: string;
  serverId?: string;
  provenanceRef?: string;
  /**
   * A locally-issued, versioned attestation. Only when present may an external
   * tool's optimistic metadata (e.g. `mutates:false`) relax the conservative
   * local posture. Absent ⇒ untrusted.
   */
  attestationRef?: string;
}

export interface DerivedCapability {
  descriptor: CapabilityDescriptor;
  /** True when external metadata tried to relax posture without attestation. */
  optimisticExternalMetadata: boolean;
}

const EXTERNAL_SOURCES: ReadonlySet<CapabilitySource['kind']> = new Set([
  'mcp_external',
  'plugin',
  'remote',
]);

function mapSourceKind(tool: CoderTool, provenance?: CapabilityProvenance): CapabilitySource['kind'] {
  if (provenance?.sourceKind) return provenance.sourceKind;
  if (tool.capabilityProvenance?.kind) return tool.capabilityProvenance.kind;
  switch (tool.source) {
    case 'native': return 'native';
    case 'mcp': return 'mcp_internal';
    case 'mcp_external': return 'mcp_external';
    default: return 'mcp_external';
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Deterministic JSON — object keys sorted recursively — for stable hashing. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function deriveSideEffect(
  externalUntrusted: boolean,
  mutates: boolean,
  mayHaveEffects: boolean,
): SideEffectContract {
  const kind: SideEffectContract['kind'] = externalUntrusted
    ? 'external'
    : mayHaveEffects ? 'local' : 'none';
  return {
    kind,
    idempotency: 'none',
    safeRetryStages: mutates ? [] : ['before_dispatch'],
    ambiguousOutcome: externalUntrusted && mayHaveEffects
      ? 'require_reconciliation'
      : 'mark_outcome_unknown',
  };
}

/**
 * Derives one descriptor with a total, conservative mapping. `tool` MUST have
 * a name and source — otherwise it is a registration bug and this throws.
 */
export function deriveCapabilityDescriptor(
  tool: CoderTool,
  provenance?: CapabilityProvenance,
): DerivedCapability {
  if (!tool.name || !tool.source) {
    throw new Error(`capability-catalog: tool is indescribable (missing name/source): ${JSON.stringify({ name: tool.name, source: tool.source })}`);
  }
  const effectiveProvenance: CapabilityProvenance = {
    sourceKind: tool.capabilityProvenance?.kind,
    providerId: tool.capabilityProvenance?.providerId,
    serverId: tool.capabilityProvenance?.serverId,
    provenanceRef: tool.capabilityProvenance?.provenanceRef,
    attestationRef: tool.capabilityProvenance?.attestationRef,
    ...provenance,
  };
  const local = resolveToolMetadata(tool);
  const sourceKind = mapSourceKind(tool, effectiveProvenance);
  const externalSource = EXTERNAL_SOURCES.has(sourceKind);
  const attested = !!effectiveProvenance.attestationRef;
  const externalUntrusted = externalSource && !attested;
  const sanitized = externalSource
    ? sanitizeUntrustedCapabilityMetadata(tool.description, tool.parameters)
    : { description: tool.description ?? '', schema: (tool.parameters as object) ?? {} };

  // Conservative posture: an untrusted external tool that declares a LOWER
  // posture (mutates:false) is overridden to the safe stance. Attestation is
  // the only escape hatch.
  const declaredMutatesFalse = tool.mutates === false;
  const optimisticExternalMetadata = externalUntrusted && declaredMutatesFalse;
  const mutates = externalUntrusted ? true : local.mutates;
  const parallelSafe = mutates ? false : local.parallelSafe;
  const riskLevel = externalUntrusted && local.riskLevel === 'read' ? 'write' : local.riskLevel;

  const source: CapabilitySource = {
    kind: sourceKind,
    providerId: effectiveProvenance.providerId ?? (sourceKind === 'native' ? 'coder-native' : 'unknown'),
    ...(effectiveProvenance.serverId ? { serverId: effectiveProvenance.serverId } : {}),
    ...(effectiveProvenance.provenanceRef ? { provenanceRef: effectiveProvenance.provenanceRef } : {}),
    metadataTrust: sourceKind === 'native' ? 'local' : attested ? 'attested' : 'untrusted',
  };

  const executionClass: CapabilityExecution['class'] = local.executionClass;
  const mayHaveEffects = mutates
    || executionClass !== 'read'
    || tool.effectBoundary !== undefined;
  const repeatPolicy: CapabilityExecution['repeatPolicy'] = mutates && local.repeatPolicy === 'stable'
    ? 'mutating'
    : local.repeatPolicy;

  const execution: CapabilityExecution = {
    class: executionClass,
    mutates,
    parallelSafe,
    repeatPolicy,
    sideEffect: deriveSideEffect(externalUntrusted, mutates, mayHaveEffects),
    timeoutPolicy: tool.timeoutMs === Infinity ? 'unbounded' : 'default',
    cancellation: 'cooperative',
  };

  const requirements: CapabilityRequirements = {
    sandboxRequired: tool.requiresSandbox ?? false,
    interactive: local.interactive,
    // Conservative: untrusted external tools are assumed to need network and
    // secrets until a local attestation narrows the scope.
    ...(externalUntrusted ? { networkScopes: ['*'], secretScopes: ['*'] } : {}),
  };

  const visibility: CapabilityVisibility = {
    defaultTier: tool.runtimeTier?.id ?? 'bootstrap',
    searchable: true,
    promptSummaryClass: 'discoverable',
  };

  const descriptor: CapabilityDescriptor = {
    capabilityId: asCapabilityId(`cap:${sourceKind}:${tool.name}`),
    version: '1',
    name: tool.name,
    aliases: [],
    displayName: tool.capabilityDisplayName ?? tool.runtimeTier?.displayName ?? tool.name,
    description: sanitized.description,
    source,
    inputSchema: sanitized.schema,
    visibility,
    execution,
    requirements,
    riskClassifierRef: `risk:${riskLevel}`,
    outputPolicyRef: 'output:default',
    enabled: true,
  };

  return { descriptor, optimisticExternalMetadata };
}

export interface DescriptorAuditFinding {
  tool: string;
  kind: 'indescribable' | 'optimistic_external_metadata';
  detail: string;
}

export interface DescriptorAuditResult {
  ok: boolean;
  checked: number;
  findings: DescriptorAuditFinding[];
}

/**
 * Release auditor (gate 8/9): every tool MUST yield a descriptor + tier, and
 * no untrusted external tool may relax the local posture without attestation.
 * Pure over the provided list so both the CLI and unit tests can call it.
 */
export function auditCapabilityDescriptors(
  tools: readonly CoderTool[],
  provenanceFor?: (tool: CoderTool) => CapabilityProvenance | undefined,
): DescriptorAuditResult {
  const findings: DescriptorAuditFinding[] = [];
  for (const tool of tools) {
    try {
      const { descriptor, optimisticExternalMetadata } = deriveCapabilityDescriptor(
        tool,
        provenanceFor?.(tool),
      );
      if (!descriptor.visibility.defaultTier) {
        findings.push({ tool: tool.name ?? '<unnamed>', kind: 'indescribable', detail: 'no default tier resolved' });
      }
      if (optimisticExternalMetadata) {
        findings.push({
          tool: tool.name,
          kind: 'optimistic_external_metadata',
          detail: 'external tool declared a lower posture (mutates:false) without a local attestation',
        });
      }
    } catch (error) {
      findings.push({
        tool: (tool as { name?: string }).name ?? '<unnamed>',
        kind: 'indescribable',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ok: findings.length === 0, checked: tools.length, findings };
}

export interface ResolveCapabilitySetOptions {
  agentRunId: AgentRunId;
  catalogVersion?: string;
  provenanceFor?: (tool: CoderTool) => CapabilityProvenance | undefined;
  resolvedAt?: string;
}

/** Catalog-only skill entry; it is never registered in the execution map. */
export function skillAsCatalogCapability(skill: ResolvedSkill): CoderTool {
  const instructionDigest = sha256Hex(skill.promptBody);
  return {
    name: skill.id,
    capabilityDisplayName: skill.name,
    description: skill.description,
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string' },
      },
      additionalProperties: false,
    },
    source: 'native',
    capabilityProvenance: {
      kind: 'skill',
      providerId: skill.author ?? skill.source,
      provenanceRef: `skill-bundle:sha256:${instructionDigest}`,
    },
    mutates: false,
    parallelSafe: true,
    executionClass: 'control',
    handler: async () => {
      throw new Error('catalog-only skill capability cannot be dispatched as a tool');
    },
  };
}

export interface ProviderToolProjectionShape {
  name: string;
  description: string;
  parameters: object;
}

/**
 * Resolves the capability set for one AgentRun. `registered`/`visible`/
 * `eligible`/`disabled` and the content hash all derive from the SAME ordered
 * descriptor list, so provider tool descriptors and the prompt summary can be
 * projected from this single source (14:517-518).
 */
export function resolveCapabilitySet(
  tools: readonly CoderTool[],
  options: ResolveCapabilitySetOptions,
): { set: ResolvedCapabilitySet; descriptors: CapabilityDescriptor[] } {
  const descriptors = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => deriveCapabilityDescriptor(tool, options.provenanceFor?.(tool)).descriptor);

  const registered = descriptors.map((d) => d.capabilityId);
  const visible = descriptors
    .filter((d) => d.visibility.promptSummaryClass !== 'hidden')
    .map((d) => d.capabilityId);
  const eligible = descriptors.filter((d) => d.enabled).map((d) => d.capabilityId);
  const disabled = descriptors
    .filter((d) => !d.enabled)
    .map((d) => ({ capabilityId: d.capabilityId, reason: 'disabled' }));

  const hash = sha256Hex(canonicalJson(descriptors));
  const catalogVersion = options.catalogVersion ?? '1';

  const set: ResolvedCapabilitySet = {
    ref: `capset:${hash}`,
    hash,
    catalogVersion,
    agentRunId: options.agentRunId,
    registered,
    visible,
    eligible,
    disabled,
    providerDescriptorsRef: `provider-descriptors:${hash}`,
    promptSummaryRef: `prompt-summary:${hash}`,
    resolvedAt: options.resolvedAt ?? new Date().toISOString(),
  };
  return { set, descriptors };
}

/**
 * Derive the exact provider projection from the same authorized descriptor
 * set used by execution. Arrays preserve provider order; object keys are
 * canonicalized for a stable SHA-256 identity.
 */
export function resolveProviderCapabilityProjection(
  authorizedTools: readonly CoderTool[],
  providerTools: readonly ProviderToolProjectionShape[],
  options: ResolveCapabilitySetOptions,
): {
  set: ResolvedCapabilitySet;
  projection: ProviderCapabilityProjection;
} {
  const { set, descriptors } = resolveCapabilitySet(authorizedTools, options);
  const descriptorsByName = new Map(
    descriptors
      .filter((descriptor) => descriptor.source.kind !== 'skill')
      .map((descriptor) => [descriptor.name, descriptor]),
  );
  const projected = providerTools.map((providerTool) => {
    const descriptor = descriptorsByName.get(providerTool.name);
    if (!descriptor) {
      throw new Error(
        `capability-catalog: provider projection contains unauthorized tool '${providerTool.name}'`,
      );
    }
    return {
      capabilityId: descriptor.capabilityId,
      version: descriptor.version,
      name: providerTool.name,
      description: providerTool.description,
      inputSchema: providerTool.parameters,
    };
  });
  const schemaBytes = Buffer.byteLength(JSON.stringify(providerTools), 'utf8');
  const digest = sha256Hex(canonicalJson({
    capabilitySetHash: set.hash,
    catalogVersion: set.catalogVersion,
    projected,
  }));
  return {
    set,
    projection: {
      ref: `projection:${digest}`,
      digest,
      capabilitySetHash: set.hash,
      catalogVersion: set.catalogVersion,
      capabilityIds: projected.map((item) => item.capabilityId),
      providerDescriptorsRef: `provider-descriptors:${digest}`,
      promptSummaryRef: `prompt-summary:${digest}`,
      schemaBytes,
    },
  };
}
