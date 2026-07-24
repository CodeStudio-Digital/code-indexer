import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { coderOrchestrationCheckpoints259 } from '@mcp/store/migrations/259_coder_orchestration_checkpoints.js';
import * as checkpoints from '../../../sessions/store/orchestration-checkpoints.js';
import { listActiveAgents } from '../../active-agent-registry.js';
import { executeWorkflow } from '../workflow-run.js';
import { buildWorkflowTool } from '../workflow-tool.js';
import {
  assertWorkflowRunLease,
  clearWorkflows,
  getWorkflow,
  releaseWorkflowRun,
  saveWorkflow,
  startWorkflowRunLeaseKeepalive,
  tryAcquireWorkflowRun,
  workflowLeaseKeepaliveActiveForTests,
  type WorkflowCheckpointStore,
} from '../workflow-registry.js';
import { planWaves, type WorkflowRecord } from '../workflow-types.js';

const SESSION_ID = 81;
let db: Database.Database;
let store: WorkflowCheckpointStore;

function checkpointStore(): WorkflowCheckpointStore {
  return {
    saveOrchestrationCheckpoint: (input) => checkpoints.save(db, input),
    loadOrchestrationCheckpoint: (sessionId, kind, scopeId) =>
      checkpoints.load(db, sessionId, kind, scopeId),
    listOrchestrationCheckpoints: (sessionId, kind, limit) =>
      checkpoints.list(db, sessionId, kind, limit),
    removeOrchestrationCheckpoint: (sessionId, kind, scopeId, token) =>
      checkpoints.remove(db, sessionId, kind, scopeId, token),
    tryAcquireOrchestrationCheckpoint: (sessionId, kind, scopeId, leaseMs) =>
      checkpoints.tryAcquire(db, sessionId, kind, scopeId, leaseMs),
    releaseOrchestrationCheckpoint: (sessionId, kind, scopeId, token) =>
      checkpoints.release(db, sessionId, kind, scopeId, token),
    renewOrchestrationCheckpoint: (sessionId, kind, scopeId, token, leaseMs) =>
      checkpoints.renew(db, sessionId, kind, scopeId, token, leaseMs),
  };
}

function record(): WorkflowRecord {
  return {
    id: 'wf_restart',
    name: 'restart proof',
    sessionId: SESSION_ID,
    status: 'running',
    steps: [
      {
        id: 'done',
        title: 'done',
        prompt: 'Authorization: Bearer TOP_SECRET_TOKEN',
        profileId: 'explore',
        dependsOn: [],
        wave: 1,
        status: 'completed',
        summary: 'password=SUPER_SECRET',
      },
      {
        id: 'next',
        title: 'next',
        prompt: 'continue after done',
        profileId: 'explore',
        dependsOn: ['done'],
        wave: 2,
        status: 'pending',
      },
    ],
    totalUsage: { input_tokens: 10, output_tokens: 5 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runCount: 1,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY);
    INSERT INTO coder_sessions (id) VALUES (${SESSION_ID});
  `);
  coderOrchestrationCheckpoints259.up(db);
  store = checkpointStore();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  clearWorkflows(SESSION_ID);
  db.close();
});

describe('workflow durable checkpoint', () => {
  it('restores after executor recreation without planning completed steps again', () => {
    expect(saveWorkflow(SESSION_ID, record(), store)).toBe(true);
    const persisted = db.prepare(`
      SELECT payload_json FROM coder_orchestration_checkpoints
      WHERE session_id=? AND checkpoint_kind='workflow' AND scope_id='wf_restart'
    `).get(SESSION_ID) as { payload_json: string };
    expect(persisted.payload_json).not.toContain('TOP_SECRET_TOKEN');
    expect(persisted.payload_json).not.toContain('SUPER_SECRET');

    // Process/realm recreation: discard only the memory cache, keep SQLite.
    clearWorkflows(SESSION_ID);
    const restored = getWorkflow(SESSION_ID, 'wf_restart', store);
    expect(restored).toBeDefined();
    expect(restored?.steps.find((step) => step.id === 'done')?.status).toBe('completed');
    expect(planWaves(restored!.steps)).toEqual([['next']]);
  });

  it('does not dispatch a stale workflow after lease expiry/takeover', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.stubEnv('CODER_ORCHESTRATION_LEASE_MS', '60000');
    expect(saveWorkflow(SESSION_ID, record(), store)).toBe(true);
    expect(tryAcquireWorkflowRun(SESSION_ID, 'wf_restart', store)).toBe(true);

    vi.setSystemTime(new Date('2026-01-01T00:01:01.000Z'));
    const winner = checkpoints.tryAcquire(db, SESSION_ID, 'workflow', 'wf_restart', 60_000);
    expect(winner).toMatch(/^lease:/);
    let dispatches = 0;
    expect(() => {
      assertWorkflowRunLease(SESSION_ID, 'wf_restart', store);
      dispatches += 1;
    }).toThrow(/fenced|expired/);
    expect(dispatches).toBe(0);

    releaseWorkflowRun(SESSION_ID, 'wf_restart', store);
    checkpoints.release(db, SESSION_ID, 'workflow', 'wf_restart', winner!);
    vi.unstubAllEnvs();
  });

  it('cleans the active-agent registry and emits no spawn when the pre-dispatch fence fails', async () => {
    const baseRenew = store.renewOrchestrationCheckpoint.bind(store);
    let renewals = 0;
    store.renewOrchestrationCheckpoint = (...args) => {
      renewals += 1;
      return renewals === 1 ? baseRenew(...args) : false;
    };
    expect(saveWorkflow(SESSION_ID, record(), store)).toBe(true);
    expect(tryAcquireWorkflowRun(SESSION_ID, 'wf_restart', store)).toBe(true);
    const emit = vi.fn();
    const runner = {
      sessionId: SESSION_ID,
      emit,
      agentLoopV2: false,
    } as unknown as CoderRunner;
    const provider: ChatProvider = {
      name: 'fake',
      model: 'fake-model',
      setModel(model) { this.model = model; },
      async *chat() {
        throw new Error('provider must not be called');
      },
    };

    await expect(executeWorkflow({
      provider,
      parentTools: [],
      sessionStore: store as never,
    }, {
      cwd: process.cwd(),
      projectName: 'test',
      runner,
    } as ToolContext, record())).rejects.toThrow(/fenced|expired/);

    expect(listActiveAgents(SESSION_ID)).toEqual([]);
    expect(emit.mock.calls.map((call) => call[0])).not.toContain('agents_group_start');
    expect(workflowLeaseKeepaliveActiveForTests(SESSION_ID, 'wf_restart')).toBe(false);
    releaseWorkflowRun(SESSION_ID, 'wf_restart', store);
  });

  it('keeps a long-running workflow lease alive and stops the timer on terminal cleanup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.stubEnv('CODER_ORCHESTRATION_LEASE_MS', '60000');
    expect(saveWorkflow(SESSION_ID, record(), store)).toBe(true);
    expect(tryAcquireWorkflowRun(SESSION_ID, 'wf_restart', store)).toBe(true);

    const stop = startWorkflowRunLeaseKeepalive(SESSION_ID, 'wf_restart', store);
    expect(workflowLeaseKeepaliveActiveForTests(SESSION_ID, 'wf_restart')).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(checkpoints.tryAcquire(db, SESSION_ID, 'workflow', 'wf_restart', 60_000)).toBeNull();

    stop();
    expect(workflowLeaseKeepaliveActiveForTests(SESSION_ID, 'wf_restart')).toBe(false);
    releaseWorkflowRun(SESSION_ID, 'wf_restart', store);
    vi.unstubAllEnvs();
  });

  it('does not mutate a loser cache and reloads the winner before a later resume', async () => {
    const winnerStore = checkpointStore();
    const loserStore = checkpointStore();
    const initial = record();
    expect(saveWorkflow(SESSION_ID, initial, winnerStore)).toBe(true);
    const cachedBefore = getWorkflow(SESSION_ID, initial.id, loserStore)!;
    const snapshotBefore = JSON.stringify(cachedBefore);

    const winnerToken = winnerStore.tryAcquireOrchestrationCheckpoint(
      SESSION_ID,
      'workflow',
      initial.id,
      120_000,
    );
    expect(winnerToken).toMatch(/^lease:/);
    const emit = vi.fn();
    const providerChat = vi.fn(async function* () {
      throw new Error('completed workflow must not dispatch');
    });
    const tool = buildWorkflowTool({
      provider: {
        name: 'fake',
        model: 'fake-model',
        setModel() {},
        chat: providerChat,
      },
      parentTools: [],
      sessionStore: loserStore as never,
    });
    const toolCtx = {
      cwd: process.cwd(),
      projectName: 'test',
      runner: { sessionId: SESSION_ID, agentLoopV2: false, emit },
    } as unknown as ToolContext;

    const lost = await tool.handler(
      { resume_workflow_id: initial.id, retry_failed: true },
      toolCtx,
    );
    expect(lost.isError).toBe(true);
    expect(String(lost.content)).toContain('already running');
    expect(JSON.stringify(cachedBefore)).toBe(snapshotBefore);

    const won = JSON.parse(snapshotBefore) as WorkflowRecord;
    won.status = 'completed';
    won.runCount += 1;
    for (const step of won.steps) {
      step.status = 'completed';
      step.summary = `winner:${step.id}`;
      step.error = undefined;
    }
    expect(winnerStore.saveOrchestrationCheckpoint({
      sessionId: SESSION_ID,
      kind: 'workflow',
      scopeId: won.id,
      privacyClass: 'session_private_redacted',
      payloadJson: JSON.stringify(won),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      leaseToken: winnerToken!,
    })).toBe(true);
    winnerStore.releaseOrchestrationCheckpoint(SESSION_ID, 'workflow', won.id, winnerToken!);

    const later = await tool.handler(
      { resume_workflow_id: won.id, retry_failed: true },
      toolCtx,
    );
    expect(later.isError).toBeFalsy();
    expect(String(later.content)).toContain('has no pending steps');
    expect(later.structuredData).toMatchObject({
      kind: 'workflow_result',
      status: 'completed',
      workflowId: won.id,
      completedCount: won.steps.length,
      stillFailed: 0,
    });
    expect(providerChat).not.toHaveBeenCalled();
    expect(getWorkflow(SESSION_ID, won.id, loserStore)?.steps.every(
      (step) => step.status === 'completed',
    )).toBe(true);
  });

  it('adopts an exactly matched terminal child without replaying the workflow step', async () => {
    const orphan = record();
    orphan.steps = [{
      id: 'child',
      title: 'child',
      prompt: 'bounded child work',
      profileId: 'explore',
      dependsOn: [],
      wave: 1,
      status: 'running',
      groupId: 'wf_restart-w1',
    }];
    expect(saveWorkflow(SESSION_ID, orphan, store)).toBe(true);
    clearWorkflows(SESSION_ID);

    const reconcileWorkflowStepRun = vi.fn(() => ({
      outcome: 'terminal' as const,
      stepStatus: 'completed' as const,
      reason: 'completed',
      runId: 'child-run-1',
      resultRef: 'result:child-run-1',
      detail: 'reconciled terminal AgentRun completed/completed',
    }));
    const durableStore = {
      ...store,
      reconcileWorkflowStepRun,
    };
    const providerChat = vi.fn(async function* () {
      throw new Error('reconciled terminal work must not be replayed');
    });
    const tool = buildWorkflowTool({
      provider: {
        name: 'fake',
        model: 'fake-model',
        setModel() {},
        chat: providerChat,
      },
      parentTools: [],
      sessionStore: durableStore as never,
    });

    const result = await tool.handler({
      resume_workflow_id: orphan.id,
      retry_failed: true,
    }, {
      cwd: process.cwd(),
      projectName: 'test',
      runner: { sessionId: SESSION_ID, agentLoopV2: false, emit: vi.fn() },
    } as unknown as ToolContext);

    expect(result.isError).toBeFalsy();
    expect(result.structuredData).toMatchObject({
      kind: 'workflow_result',
      status: 'completed',
      workflowId: orphan.id,
    });
    expect(providerChat).not.toHaveBeenCalled();
    expect(reconcileWorkflowStepRun).toHaveBeenCalledWith(
      SESSION_ID,
      'wf_restart-w1',
      'child',
    );
    const persisted = getWorkflow(SESSION_ID, orphan.id, durableStore)!;
    expect(persisted.status).toBe('completed');
    expect(persisted.steps[0].status).toBe('completed');
    expect(persisted.steps[0].summary).toContain('reconciled after executor crash');
  });

  it('persists outcome_unknown and does not replay it on the same retry_failed recovery call', async () => {
    const orphan = record();
    orphan.steps = [{
      id: 'child',
      title: 'child',
      prompt: 'possibly acknowledged work',
      profileId: 'explore',
      dependsOn: [],
      wave: 1,
      status: 'running',
      groupId: 'wf_restart-w1',
    }];
    expect(saveWorkflow(SESSION_ID, orphan, store)).toBe(true);
    clearWorkflows(SESSION_ID);

    const reconcileWorkflowStepRun = vi.fn(() => ({
      outcome: 'outcome_unknown' as const,
      runId: 'child-run-1',
      detail: 'child lifecycle is still nonterminal',
    }));
    const durableStore = {
      ...store,
      reconcileWorkflowStepRun,
    };
    const providerChat = vi.fn(async function* () {
      throw new Error('first recovery call must not accept replay risk implicitly');
    });
    const tool = buildWorkflowTool({
      provider: {
        name: 'fake',
        model: 'fake-model',
        setModel() {},
        chat: providerChat,
      },
      parentTools: [],
      sessionStore: durableStore as never,
    });

    const result = await tool.handler({
      resume_workflow_id: orphan.id,
      retry_failed: true,
    }, {
      cwd: process.cwd(),
      projectName: 'test',
      runner: { sessionId: SESSION_ID, agentLoopV2: false, emit: vi.fn() },
    } as unknown as ToolContext);

    expect(result.isError).toBe(true);
    expect(result.structuredData).toMatchObject({
      kind: 'workflow_result',
      status: 'failed',
      workflowId: orphan.id,
      failedCount: 1,
      stillFailed: 1,
    });
    expect(providerChat).not.toHaveBeenCalled();
    const persisted = getWorkflow(SESSION_ID, orphan.id, durableStore)!;
    expect(persisted.status).toBe('failed');
    expect(persisted.steps[0].status).toBe('failed');
    expect(persisted.steps[0].error).toContain('outcome_unknown');
    expect(persisted.steps[0].error).toContain('again');
  });
});
