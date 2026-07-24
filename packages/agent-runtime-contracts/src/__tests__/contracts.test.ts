import { describe, expect, it } from 'vitest';
import {
  CONTROL_PLANE_EVENT_TYPES,
  asAgentRunId,
  asSessionCommandId,
  asSessionId,
  isResolvedAgentRun,
  runtimeEventClass,
  type AgentRun,
  type RuntimeEventClass,
} from '../index.js';

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
    agentRunId: asAgentRunId('agent-run:1'),
    specVersion: 1,
    sessionId: asSessionId('session:1'),
    commandId: asSessionCommandId('command:1'),
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
