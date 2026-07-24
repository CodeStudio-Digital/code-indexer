import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import {
  CONTROL_PLANE_SCHEMA_VERSION,
  asAgentRunAttemptId,
  asAgentRunId,
  asCorrelationId,
  asSessionCommandId,
  asSessionId,
  isResolvedAgentRun,
} from '@mcp/agent-runtime-contracts';
import { controlPlaneFoundation251 } from '../../migrations/251_control_plane_foundation.js';
import { agentRunChildCardinality257 } from '../../migrations/257_agent_run_child_cardinality.js';
import { ControlPlaneStore } from '../control-plane-store.js';
import { AgentRunFenceError } from '../agent-run-store.js';
import { hashControlPlanePayload } from '../codec.js';
import type { AgentRunResolutionPatch, AgentRunSeed, ControlPlaneRunContext } from '../types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

const ACTOR = { actorId: 'test-user', actorType: 'user' as const, source: 'http' as const };
const SESSION = asSessionId('session:test');

let db: DB;
let store: ControlPlaneStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
  controlPlaneFoundation251.up(db);
  agentRunChildCardinality257.up(db);
  store = new ControlPlaneStore(db, { journalEnabled: true });
});

afterEach(() => db.close());

/** Accepts a command+run so the FK chain (session→command→run→attempt) is real. */
function acceptRun(params: {
  commandId: string;
  agentRunId: string;
  attemptId: string;
  seed?: Partial<AgentRunSeed>;
}): void {
  const payload = { content: `run ${params.agentRunId}` };
  const command = {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    commandId: asSessionCommandId(params.commandId),
    idempotencyKey: `idem:${params.commandId}`,
    kind: 'start' as const,
    sessionId: SESSION,
    actor: ACTOR,
    requestedAt: '2026-01-01T00:00:00.000Z',
    correlationId: asCorrelationId(`corr:${params.commandId}`),
    payload,
  };
  const result = store.acceptCommand({
    command,
    payloadHash: hashControlPlanePayload(payload),
    run: {
      agentRunId: asAgentRunId(params.agentRunId),
      attemptId: asAgentRunAttemptId(params.attemptId),
      role: 'build',
      agentDefinitionId: 'build',
      waitMode: 'foreground',
      requestedCapabilityProfile: 'navigate',
      executorOwnerId: `coder-worker:${params.agentRunId}`,
      executorExpiresAt: '2099-01-01T00:00:00.000Z',
      ...params.seed,
    },
  });
  expect(result.kind).toBe('accepted');
}

function ctxFor(commandId: string, agentRunId: string, attemptId: string): ControlPlaneRunContext {
  return {
    sessionId: SESSION,
    commandId: asSessionCommandId(commandId),
    correlationId: asCorrelationId(`corr:${commandId}`),
    actor: ACTOR,
    agentRunId: asAgentRunId(agentRunId),
    attemptId: asAgentRunAttemptId(attemptId),
    executorOwnerId: `coder-worker:${agentRunId}`,
    fencingEpoch: 1,
  };
}

function resolutionPatch(): AgentRunResolutionPatch {
  return {
    effectiveProvider: 'anthropic',
    effectiveModel: 'claude-x',
    capabilitySetRef: 'capset:abc',
    environmentId: 'env:1' as never,
    presetResolutionRef: 'preset:1',
    policySnapshotRef: 'policy:1',
    effectiveReasoningEffort: 'high',
    effectivePreset: 'ultra',
    downgradeReasons: [{ code: 'effort_capped', dimension: 'effort', requested: 'xhigh', effective: 'high' }],
  };
}

describe('AgentRunStore hierarchy', () => {
  it('persists and re-hydrates a child run; a root run keeps the pre-Fase-3 defaults', () => {
    acceptRun({ commandId: 'command:root', agentRunId: 'agent-run:root', attemptId: 'attempt:root' });
    acceptRun({
      commandId: 'command:child',
      agentRunId: 'agent-run:child',
      attemptId: 'attempt:child',
      seed: {
        ownerAgentRunId: asAgentRunId('agent-run:root'),
        parentAgentRunId: asAgentRunId('agent-run:root'),
        spawnDepth: 1,
      },
    });

    const child = store.runs.get('agent-run:child')!;
    expect(child.ownerAgentRunId).toBe('agent-run:root');
    expect(child.parentAgentRunId).toBe('agent-run:root');
    expect(child.spawnDepth).toBe(1);

    const root = store.runs.get('agent-run:root')!;
    expect(root.ownerAgentRunId).toBeUndefined();
    expect(root.parentAgentRunId).toBeUndefined();
    expect(root.spawnDepth).toBe(0);
  });

  it('transitions a child that shares the root command and fences a forged hierarchy', () => {
    acceptRun({ commandId: 'command:root', agentRunId: 'agent-run:root', attemptId: 'attempt:root' });
    const rootCommand = store.commands.get('command:root')!;

    db.transaction(() => {
      store.runs.create(rootCommand, undefined, {
        agentRunId: asAgentRunId('agent-run:child'),
        attemptId: asAgentRunAttemptId('attempt:child'),
        ownerAgentRunId: asAgentRunId('agent-run:root'),
        parentAgentRunId: asAgentRunId('agent-run:root'),
        spawnDepth: 1,
        role: 'subagent',
        agentDefinitionId: 'investigator',
        waitMode: 'foreground',
        requestedCapabilityProfile: 'readonly',
        executorOwnerId: 'coder-worker:agent-run:child',
        executorExpiresAt: '2099-01-01T00:00:00.000Z',
      });
      store.runs.createInitialAttempt('agent-run:child', {
        agentRunId: asAgentRunId('agent-run:child'),
        attemptId: asAgentRunAttemptId('attempt:child'),
        role: 'subagent',
        agentDefinitionId: 'investigator',
        waitMode: 'foreground',
        requestedCapabilityProfile: 'readonly',
        executorOwnerId: 'coder-worker:agent-run:child',
        executorExpiresAt: '2099-01-01T00:00:00.000Z',
      });
    })();

    const childContext = ctxFor('command:root', 'agent-run:child', 'attempt:child');
    store.runs.markAttemptRunning(childContext, 'coder-run:child');
    expect(store.runs.transition(childContext, 'running')).toMatchObject({
      status: 'running',
      commandId: 'command:root',
      parentAgentRunId: 'agent-run:root',
    });
    expect(store.runs.getByCommand('command:root')?.agentRunId).toBe('agent-run:root');

    store.interruptRun({
      context: childContext,
      status: 'interrupted',
      commandStatus: 'failed',
      reason: 'worker_restart',
    });
    expect(store.runs.get('agent-run:child')).toMatchObject({
      status: 'interrupted',
      terminalReason: 'worker_restart',
    });
    expect(store.runs.getAttempt('attempt:child')).toMatchObject({
      status: 'terminal',
      terminalReason: 'worker_restart',
      executorLease: { status: 'fenced' },
    });
    expect(store.commands.get('command:root')).toMatchObject({
      status: 'accepted',
      agentRunId: 'agent-run:root',
    });
    expect(store.runs.get('agent-run:root')).toMatchObject({ status: 'starting' });

    acceptRun({ commandId: 'command:other', agentRunId: 'agent-run:other-root', attemptId: 'attempt:other-root' });
    db.transaction(() => {
      store.runs.create(rootCommand, undefined, {
        agentRunId: asAgentRunId('agent-run:forged-child'),
        attemptId: asAgentRunAttemptId('attempt:forged-child'),
        ownerAgentRunId: asAgentRunId('agent-run:other-root'),
        parentAgentRunId: asAgentRunId('agent-run:other-root'),
        spawnDepth: 1,
        role: 'subagent',
        agentDefinitionId: 'investigator',
        waitMode: 'foreground',
        requestedCapabilityProfile: 'readonly',
        executorOwnerId: 'coder-worker:agent-run:forged-child',
        executorExpiresAt: '2099-01-01T00:00:00.000Z',
      });
      store.runs.createInitialAttempt('agent-run:forged-child', {
        agentRunId: asAgentRunId('agent-run:forged-child'),
        attemptId: asAgentRunAttemptId('attempt:forged-child'),
        role: 'subagent',
        agentDefinitionId: 'investigator',
        waitMode: 'foreground',
        requestedCapabilityProfile: 'readonly',
        executorOwnerId: 'coder-worker:agent-run:forged-child',
        executorExpiresAt: '2099-01-01T00:00:00.000Z',
      });
    })();
    expect(() => store.runs.markAttemptRunning(
      ctxFor('command:root', 'agent-run:forged-child', 'attempt:forged-child'),
      'coder-run:forged-child',
    )).toThrow(AgentRunFenceError);
  });
});

describe('AgentRunStore resolution', () => {
  it('accepts resolution supplied at create time', () => {
    acceptRun({
      commandId: 'command:resolved',
      agentRunId: 'agent-run:resolved',
      attemptId: 'attempt:resolved',
      seed: {
        effectiveProvider: 'anthropic',
        effectiveModel: 'claude-x',
        capabilitySetRef: 'capset:1',
        environmentId: 'env:1' as never,
        presetResolutionRef: 'preset:1',
        policySnapshotRef: 'policy:1',
      },
    });
    expect(isResolvedAgentRun(store.runs.get('agent-run:resolved')!)).toBe(true);
  });

  it('starts unresolved and becomes resolved after markResolved (version bumped, status untouched)', () => {
    acceptRun({ commandId: 'command:root', agentRunId: 'agent-run:root', attemptId: 'attempt:root' });
    const before = store.runs.get('agent-run:root')!;
    expect(isResolvedAgentRun(before)).toBe(false);
    expect(before.version).toBe(1);
    expect(before.status).toBe('starting');

    const resolved = store.runs.markResolved(
      ctxFor('command:root', 'agent-run:root', 'attempt:root'),
      resolutionPatch(),
    );
    expect(resolved.version).toBe(2);
    expect(resolved.status).toBe('starting'); // lease/status untouched
    expect(isResolvedAgentRun(resolved)).toBe(true);
    expect(resolved).toMatchObject({
      effectiveProvider: 'anthropic',
      effectiveModel: 'claude-x',
      capabilitySetRef: 'capset:abc',
      environmentId: 'env:1',
      presetResolutionRef: 'preset:1',
      policySnapshotRef: 'policy:1',
      effectiveReasoningEffort: 'high',
      effectivePreset: 'ultra',
    });
    expect(resolved.downgradeReasons).toEqual([
      { code: 'effort_capped', dimension: 'effort', requested: 'xhigh', effective: 'high' },
    ]);

    // The active attempt is still active — markResolved never touched the lease.
    expect(store.runs.getAttempt('attempt:root')).toMatchObject({
      status: 'starting',
      executorLease: { status: 'active' },
    });
  });

  it('honors an explicit expectedVersion for the CAS', () => {
    acceptRun({ commandId: 'command:root', agentRunId: 'agent-run:root', attemptId: 'attempt:root' });
    const resolved = store.runs.markResolved(
      ctxFor('command:root', 'agent-run:root', 'attempt:root'),
      resolutionPatch(),
      1, // current version
    );
    expect(resolved.version).toBe(2);
  });

  it('fences a stale expectedVersion', () => {
    acceptRun({ commandId: 'command:root', agentRunId: 'agent-run:root', attemptId: 'attempt:root' });
    expect(() => store.runs.markResolved(
      ctxFor('command:root', 'agent-run:root', 'attempt:root'),
      resolutionPatch(),
      99,
    )).toThrow(AgentRunFenceError);
    // Nothing was written.
    expect(isResolvedAgentRun(store.runs.get('agent-run:root')!)).toBe(false);
  });

  it('fences an executor owner/epoch mismatch', () => {
    acceptRun({ commandId: 'command:root', agentRunId: 'agent-run:root', attemptId: 'attempt:root' });
    const intruder = { ...ctxFor('command:root', 'agent-run:root', 'attempt:root'), executorOwnerId: 'intruder' };
    expect(() => store.runs.markResolved(intruder, resolutionPatch())).toThrow(AgentRunFenceError);
    expect(isResolvedAgentRun(store.runs.get('agent-run:root')!)).toBe(false);
  });
});
