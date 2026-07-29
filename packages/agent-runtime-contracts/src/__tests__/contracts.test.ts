import { describe, expect, it } from 'vitest';
import {
  CONTROL_PLANE_EVENT_TYPES,
  asAgentRunAttemptId,
  asAgentRunId,
  asCorrelationId,
  asRuntimeEventId,
  asSessionCommandId,
  asSessionId,
  isResolvedAgentRun,
  runtimeEventClass,
  type AgentRun,
  type RuntimeEventClass,
} from '../index.js';

describe('operational UUID identifiers', () => {
  const factories = [
    asSessionId,
    asSessionCommandId,
    asAgentRunId,
    asAgentRunAttemptId,
    asRuntimeEventId,
    asCorrelationId,
  ];

  it('accepts canonical UUID strings and normalizes casing', () => {
    for (const factory of factories) {
      expect(factory('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')).toBe(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );
    }
  });

  it('rejects prefixed and numeric legacy identities', () => {
    for (const factory of factories) {
      expect(() => factory('session:1')).toThrow(/canonical UUID/);
      expect(() => factory('42')).toThrow(/canonical UUID/);
    }
  });
});

describe('runtimeEventClass', () => {
  it('classifies command/control events as class A', () => {
    const classA = [
      CONTROL_PLANE_EVENT_TYPES.commandAccepted,
      CONTROL_PLANE_EVENT_TYPES.commandSucceeded,
      CONTROL_PLANE_EVENT_TYPES.commandRejected,
      CONTROL_PLANE_EVENT_TYPES.commandFailed,
      CONTROL_PLANE_EVENT_TYPES.commandCancelled,
      // 14-target-control-plane-contracts.md §15: run created is command/control.
      CONTROL_PLANE_EVENT_TYPES.agentRunCreated,
      CONTROL_PLANE_EVENT_TYPES.toolApprovalResolved,
      CONTROL_PLANE_EVENT_TYPES.interactionResolved,
    ];
    for (const type of classA) {
      expect(runtimeEventClass(type), type).toBe('A');
    }
  });

  it('classifies side-effect boundaries as class B and lifecycle as class C', () => {
    const expected: Array<[string, RuntimeEventClass]> = [
      [CONTROL_PLANE_EVENT_TYPES.toolInvocationStarted, 'B'],
      [CONTROL_PLANE_EVENT_TYPES.toolInvocationCompleted, 'B'],
      [CONTROL_PLANE_EVENT_TYPES.agentRunStarted, 'C'],
      [CONTROL_PLANE_EVENT_TYPES.toolApprovalRequested, 'C'],
      [CONTROL_PLANE_EVENT_TYPES.interactionRequested, 'C'],
      [CONTROL_PLANE_EVENT_TYPES.providerSwapped, 'C'],
      [CONTROL_PLANE_EVENT_TYPES.providerFallback, 'C'],
      [CONTROL_PLANE_EVENT_TYPES.historyCompacted, 'C'],
      [CONTROL_PLANE_EVENT_TYPES.workflowRunStarted, 'C'],
      [CONTROL_PLANE_EVENT_TYPES.workflowRunFinished, 'C'],
      [CONTROL_PLANE_EVENT_TYPES.agentsGroupStarted, 'C'],
      [CONTROL_PLANE_EVENT_TYPES.agentsGroupFinished, 'C'],
      [CONTROL_PLANE_EVENT_TYPES.worktreeEntered, 'C'],
      [CONTROL_PLANE_EVENT_TYPES.worktreeExited, 'C'],
      [CONTROL_PLANE_EVENT_TYPES.transcriptPersisted, 'C'],
      [CONTROL_PLANE_EVENT_TYPES.agentRunCompleted, 'C'],
      [CONTROL_PLANE_EVENT_TYPES.agentRunFailed, 'C'],
      [CONTROL_PLANE_EVENT_TYPES.agentRunAborted, 'C'],
      [CONTROL_PLANE_EVENT_TYPES.agentRunInterrupted, 'C'],
    ];
    for (const [type, eventClass] of expected) {
      expect(runtimeEventClass(type as never), type).toBe(eventClass);
    }
  });
});

describe('isResolvedAgentRun', () => {
  const baseRun: AgentRun = {
    agentRunId: asAgentRunId('22222222-2222-4222-8222-222222222222'),
    specVersion: 1,
    sessionId: asSessionId('11111111-1111-4111-8111-111111111111'),
    commandId: asSessionCommandId('33333333-3333-4333-8333-333333333333'),
    spawnDepth: 0,
    role: 'build',
    status: 'running',
    downgradeReasons: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  };

  it('is false while any mandatory resolution field is missing', () => {
    expect(isResolvedAgentRun(baseRun)).toBe(false);
    expect(isResolvedAgentRun({
      ...baseRun,
      effectiveProvider: 'kimi',
      effectiveModel: 'k2',
      capabilitySetRef: 'capset:1',
      environmentId: 'env:1' as never,
      presetResolutionRef: 'preset:1',
      // policySnapshotRef still missing
    })).toBe(false);
  });

  it('is true once provider, model, capability set, environment, preset and policy are resolved', () => {
    expect(isResolvedAgentRun({
      ...baseRun,
      effectiveProvider: 'kimi',
      effectiveModel: 'k2',
      capabilitySetRef: 'capset:1',
      environmentId: 'env:1' as never,
      presetResolutionRef: 'preset:1',
      policySnapshotRef: 'policy:1',
    })).toBe(true);
  });
});
