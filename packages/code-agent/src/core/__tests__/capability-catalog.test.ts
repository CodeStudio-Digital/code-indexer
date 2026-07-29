import { describe, expect, it } from 'vitest';
import {
  auditCapabilityDescriptors,
  deriveCapabilityDescriptor,
  resolveCapabilitySet,
} from '../capability-catalog.js';
import type { CoderTool } from '../tool.js';
import type { AgentRunId } from '@mcp/agent-runtime-contracts';

function tool(overrides: Partial<CoderTool> & { name: string; source: CoderTool['source'] }): CoderTool {
  return {
    description: 'test tool',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ content: '' }) as never,
    ...overrides,
  } as CoderTool;
}

const RUN =
  '11111111-1111-4111-8111-111111111111' as AgentRunId;

describe('deriveCapabilityDescriptor', () => {
  it('maps a native read tool to a non-mutating, locally-trusted descriptor', () => {
    const { descriptor } = deriveCapabilityDescriptor(
      tool({ name: 'read_file', source: 'native', mutates: false, riskLevel: 'read' }),
    );
    expect(descriptor.source.kind).toBe('native');
    expect(descriptor.source.metadataTrust).toBe('local');
    expect(descriptor.execution.mutates).toBe(false);
    expect(descriptor.execution.sideEffect.kind).toBe('none');
    expect(descriptor.enabled).toBe(true);
  });

  it('maps an internal mcp tool source to mcp_internal', () => {
    const { descriptor } = deriveCapabilityDescriptor(
      tool({ name: 'mcp__search', source: 'mcp', mutates: false }),
    );
    expect(descriptor.source.kind).toBe('mcp_internal');
  });

  it('forces conservative posture on an external tool that lies about mutation', () => {
    const { descriptor, optimisticExternalMetadata } = deriveCapabilityDescriptor(
      tool({ name: 'mcp__mail__send', source: 'mcp_external', mutates: false, riskLevel: 'read' }),
    );
    expect(optimisticExternalMetadata).toBe(true);
    // Untrusted external metadata never reduces the local posture.
    expect(descriptor.execution.mutates).toBe(true);
    expect(descriptor.execution.parallelSafe).toBe(false);
    expect(descriptor.execution.sideEffect.kind).toBe('external');
    expect(descriptor.execution.sideEffect.ambiguousOutcome).toBe('require_reconciliation');
    expect(descriptor.requirements.networkScopes).toEqual(['*']);
    expect(descriptor.requirements.secretScopes).toEqual(['*']);
    expect(descriptor.source.metadataTrust).toBe('untrusted');
  });

  it('honors a plugin source via provenance and relaxes only with attestation', () => {
    const base = tool({ name: 'plugin__do', source: 'mcp_external', mutates: false });
    const untrusted = deriveCapabilityDescriptor(base, { sourceKind: 'plugin', providerId: 'acme' });
    expect(untrusted.descriptor.source.kind).toBe('plugin');
    expect(untrusted.descriptor.execution.mutates).toBe(true);

    const attested = deriveCapabilityDescriptor(base, {
      sourceKind: 'plugin',
      providerId: 'acme',
      attestationRef: 'attest:v1',
    });
    expect(attested.descriptor.source.metadataTrust).toBe('attested');
    expect(attested.descriptor.execution.mutates).toBe(false);
    expect(attested.optimisticExternalMetadata).toBe(false);
  });

  it('throws for an indescribable tool (missing source)', () => {
    expect(() => deriveCapabilityDescriptor({ name: 'broken' } as unknown as CoderTool))
      .toThrow(/indescribable/);
  });
});

describe('resolveCapabilitySet', () => {
  const tools = [
    tool({ name: 'read_file', source: 'native', mutates: false, riskLevel: 'read' }),
    tool({ name: 'edit_file', source: 'native', mutates: true, riskLevel: 'write' }),
    tool({ name: 'mcp__mail__send', source: 'mcp_external' }),
  ];

  it('derives registered/visible/eligible from the same ordered descriptor list with a stable hash', () => {
    const a = resolveCapabilitySet(tools, { agentRunId: RUN, resolvedAt: '2026-01-01T00:00:00.000Z' });
    const b = resolveCapabilitySet([...tools].reverse(), { agentRunId: RUN, resolvedAt: '2026-01-02T00:00:00.000Z' });
    // Hash is order-independent (descriptors sorted by name) and time-independent.
    expect(a.set.hash).toBe(b.set.hash);
    expect(a.set.registered).toHaveLength(3);
    expect(a.set.ref).toBe(`capset:${a.set.hash}`);
    // No `authorized` field exists on the contract.
    expect('authorized' in a.set).toBe(false);
  });

  it('changes the hash when a descriptor posture changes', () => {
    const a = resolveCapabilitySet(tools, { agentRunId: RUN });
    const mutated = resolveCapabilitySet(
      [...tools, tool({ name: 'run_command', source: 'native', mutates: true, riskLevel: 'execute' })],
      { agentRunId: RUN },
    );
    expect(a.set.hash).not.toBe(mutated.set.hash);
  });
});

describe('auditCapabilityDescriptors', () => {
  it('passes for a well-formed native catalog', () => {
    const result = auditCapabilityDescriptors([
      tool({ name: 'read_file', source: 'native', mutates: false }),
      tool({ name: 'edit_file', source: 'native', mutates: true }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('flags an indescribable tool and an optimistic external tool', () => {
    const result = auditCapabilityDescriptors([
      { name: 'broken' } as unknown as CoderTool,
      tool({ name: 'mcp__mail__send', source: 'mcp_external', mutates: false }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind).sort()).toEqual([
      'indescribable',
      'optimistic_external_metadata',
    ]);
  });
});
