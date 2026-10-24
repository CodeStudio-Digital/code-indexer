import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { FsSessionStore } from '../../../sessions/fs-store/fs-session-store.js';
import type { SessionId } from '@mcp/session-storage';
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

let temporaryRoot: string;
let projectRoot: string;
let dataDir: string;
let sessionId: SessionId;
let fsStore: FsSessionStore;
let store: WorkflowCheckpointStore;

function checkpointStore(): WorkflowCheckpointStore {
  return {
    saveOrchestrationCheckpoint: (input) =>
      fsStore.saveOrchestrationCheckpoint(input),
    loadOrchestrationCheckpoint: (sessionId, kind, scopeId) =>
      fsStore.loadOrchestrationCheckpoint(sessionId, kind, scopeId),
    listOrchestrationCheckpoints: (sessionId, kind, limit) =>
      fsStore.listOrchestrationCheckpoints(sessionId, kind, limit),
    removeOrchestrationCheckpoint: (sessionId, kind, scopeId, token) =>
      fsStore.removeOrchestrationCheckpoint(
        sessionId,
        kind,
        scopeId,
        token,
      ),
    tryAcquireOrchestrationCheckpoint: (sessionId, kind, scopeId, leaseMs) =>
      fsStore.tryAcquireOrchestrationCheckpoint(
        sessionId,
        kind,
        scopeId,
        leaseMs,
      ),
    releaseOrchestrationCheckpoint: (sessionId, kind, scopeId, token) =>
      fsStore.releaseOrchestrationCheckpoint(
        sessionId,
        kind,
        scopeId,
        token,
      ),
    renewOrchestrationCheckpoint: (sessionId, kind, scopeId, token, leaseMs) =>
      fsStore.renewOrchestrationCheckpoint(
        sessionId,
        kind,
        scopeId,
        token,
        leaseMs,
      ),
  };
}

function record(): WorkflowRecord {
  return {
    id: 'wf_restart',
    name: 'restart proof',
    sessionId,
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

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'workflow-checkpoint-'));
  projectRoot = join(temporaryRoot, 'project');
  dataDir = join(temporaryRoot, 'data');
  await Promise.all([mkdir(projectRoot), mkdir(dataDir)]);
  fsStore = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 81 ? projectRoot : null,
      listProjectRoots: () => [
        { project_id: 81, root_path: projectRoot },
      ],
    },
  });
  sessionId = (
    await fsStore.createSession({
      project_id: 81,
      title: 'workflow checkpoint',
      provider: 'fake',
      model: 'fake-model',
    })
  ).id;
  store = checkpointStore();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await clearWorkflows(sessionId);
  await fsStore.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('workflow durable checkpoint', () => {

  it('restores after executor recreation without planning completed steps again', async () => {
    expect(await saveWorkflow(sessionId, record(), store)).toBe(true);
    const persisted = await store.loadOrchestrationCheckpoint(
      sessionId,
      'workflow',
      'wf_restart',
    );
    expect(persisted).not.toBeNull();
    expect(persisted!.payload_json).not.toContain('TOP_SECRET_TOKEN');
    expect(persisted!.payload_json).not.toContain('SUPER_SECRET');

    // Process/realm recreation: discard memory, keep the bundle checkpoint.
    await clearWorkflows(sessionId);
    const restored = await getWorkflow(sessionId, 'wf_restart', store);
    expect(restored).toBeDefined();
    expect(restored?.steps.find((step) => step.id === 'done')?.status).toBe('completed');
    expect(planWaves(restored!.steps)).toEqual([['next']]);
  });

  it('does not dispatch a stale workflow after lease expiry/takeover', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    expect(await saveWorkflow(sessionId, record(), store)).toBe(true);
    expect(
      await tryAcquireWorkflowRun(sessionId, 'wf_restart', store),
    ).toBe(true);

    vi.setSystemTime(new Date('2026-01-01T00:02:01.000Z'));
    const winner = await fsStore.tryAcquireOrchestrationCheckpoint(
      sessionId,
      'workflow',
      'wf_restart',
      120_000,
    );
    expect(winner).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    let dispatches = 0;
    await expect((async () => {
      await assertWorkflowRunLease(sessionId, 'wf_restart', store);
      dispatches += 1;
    })()).rejects.toThrow(/fenced|expired/);
    expect(dispatches).toBe(0);

    await releaseWorkflowRun(sessionId, 'wf_restart', store);
    await fsStore.releaseOrchestrationCheckpoint(
      sessionId,
      'workflow',
      'wf_restart',
      winner!,
    );
  });

  it('cleans the active-agent registry and emits no spawn when the pre-dispatch fence fails', async () => {
    const baseRenew = store.renewOrchestrationCheckpoint.bind(store);
    let renewals = 0;
    store.renewOrchestrationCheckpoint = (...args) => {
      renewals += 1;
      return renewals === 1
        ? baseRenew(...args)
        : Promise.resolve(false);
    };
    expect(await saveWorkflow(sessionId, record(), store)).toBe(true);
    expect(
      await tryAcquireWorkflowRun(sessionId, 'wf_restart', store),
    ).toBe(true);
    const emit = vi.fn();
    const runner = {
      sessionId,
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

    expect(listActiveAgents(sessionId)).toEqual([]);
    expect(emit.mock.calls.map((call) => call[0])).not.toContain('agents_group_start');
    expect(
      workflowLeaseKeepaliveActiveForTests(sessionId, 'wf_restart'),
    ).toBe(false);
    await releaseWorkflowRun(sessionId, 'wf_restart', store);
  });

  it('keeps a long-running workflow lease alive and stops the timer on terminal cleanup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.stubEnv('CODER_ORCHESTRATION_LEASE_MS', '60000');
    expect(await saveWorkflow(sessionId, record(), store)).toBe(true);
    expect(
      await tryAcquireWorkflowRun(sessionId, 'wf_restart', store),
    ).toBe(true);

    const stop = startWorkflowRunLeaseKeepalive(
      sessionId,
      'wf_restart',
      store,
    );
    expect(
      workflowLeaseKeepaliveActiveForTests(sessionId, 'wf_restart'),
    ).toBe(true);
    for (let elapsed = 0; elapsed < 3 * 60_000; elapsed += 20_000) {
      await vi.advanceTimersByTimeAsync(20_000);
      await assertWorkflowRunLease(
        sessionId,
        'wf_restart',
        store,
      );
    }
    expect(
      await fsStore.tryAcquireOrchestrationCheckpoint(
        sessionId,
        'workflow',
        'wf_restart',
        60_000,
      ),
    ).toBeNull();

    stop();
    expect(
      workflowLeaseKeepaliveActiveForTests(sessionId, 'wf_restart'),
    ).toBe(false);
    await releaseWorkflowRun(sessionId, 'wf_restart', store);
    vi.unstubAllEnvs();
  });

  it('does not mutate a loser cache and reloads the winner before a later resume', async () => {
    const winnerStore = checkpointStore();
    const loserStore = checkpointStore();
    const initial = record();
    expect(await saveWorkflow(sessionId, initial, winnerStore)).toBe(true);
    const cachedBefore = await getWorkflow(
      sessionId,
      initial.id,
      loserStore,
    );
    expect(cachedBefore).toBeDefined();
    const snapshotBefore = JSON.stringify(cachedBefore);

    const winnerToken =
      await winnerStore.tryAcquireOrchestrationCheckpoint(
      sessionId,
      'workflow',
      initial.id,
      120_000,
    );
    expect(winnerToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
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
      runner: { sessionId, agentLoopV2: false, emit },
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
    expect(await winnerStore.saveOrchestrationCheckpoint({
      sessionId,
      kind: 'workflow',
      scopeId: won.id,
      privacyClass: 'session_private_redacted',
      payloadJson: JSON.stringify(won),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      leaseToken: winnerToken!,
    })).toBe(true);
    await winnerStore.releaseOrchestrationCheckpoint(
      sessionId,
      'workflow',
      won.id,
      winnerToken!,
    );

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
    const restored = await getWorkflow(sessionId, won.id, loserStore);
    expect(
      restored?.steps.every((step) => step.status === 'completed'),
    ).toBe(true);
  });

  it.each(['lost_ack', 'worker_restart'] as const)('keeps real filesystem child evidence uncertain across repeated resumes: %s', async failure => {
    const orphan = record();
    orphan.steps = [{ id: 'child', title: 'child', prompt: 'possibly applied write', profileId: 'implement',
      dependsOn: [], wave: 1, status: 'running', groupId: 'wf_restart-w1' }];
    const runId = randomUUID();
    const fence = await fsStore.startSubagentRun({ session_id: sessionId, run_id: runId, profile: 'implement',
      max_turns: 4, spawn_id: 'wf_restart-w1', label: 'child' });
    if (failure === 'lost_ack') await fsStore.completeSubagentRun({ run_id: runId, reason: 'outcome_unknown', fence,
      turns: 1, auto_continues: 0, tool_calls: 1, logical_operations: 1, productive_operations: 0,
      paginate_calls: 0, duplicate_calls: 0, error_calls: 1, refused_calls: 0, elapsed_ms: 1,
      input_tokens: 1, output_tokens: 0, has_summary: true });
    else await fsStore.recoverOrphanedSubagentRuns();
    expect(await fsStore.reconcileWorkflowStepRun(sessionId, 'wf_restart-w1', 'child')).toMatchObject({ outcome: 'outcome_unknown' });
    await saveWorkflow(sessionId, orphan, store);
    const chat = vi.fn(async function* () { throw new Error('must not replay'); });
    const tool = buildWorkflowTool({ provider: { name: 'fake', model: 'fake', setModel() {}, chat }, parentTools: [], sessionStore: fsStore });
    for (let attempt = 0; attempt < 3; attempt++) {
      await clearWorkflows(sessionId);
      expect(await tool.handler({ resume_workflow_id: orphan.id, retry_failed: true }, {
        cwd: projectRoot, projectName: 'test', runner: { sessionId, agentLoopV2: false, emit: vi.fn() },
      } as unknown as ToolContext)).toMatchObject({ isError: true, effectOutcome: 'unknown' });
    }
    expect(chat).not.toHaveBeenCalled();
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
    expect(await saveWorkflow(sessionId, orphan, store)).toBe(true);
    await clearWorkflows(sessionId);

    const reconcileWorkflowStepRun = vi.fn(async () => ({
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
      runner: { sessionId, agentLoopV2: false, emit: vi.fn() },
    } as unknown as ToolContext);

    expect(result.isError).toBeFalsy();
    expect(result.structuredData).toMatchObject({
      kind: 'workflow_result',
      status: 'completed',
      workflowId: orphan.id,
    });
    expect(providerChat).not.toHaveBeenCalled();
    expect(reconcileWorkflowStepRun).toHaveBeenCalledWith(
      sessionId,
      'wf_restart-w1',
      'child',
    );
    const persisted = await getWorkflow(
      sessionId,
      orphan.id,
      durableStore,
    );
    expect(persisted).toBeDefined();
    expect(persisted!.status).toBe('completed');
    expect(persisted!.steps[0].status).toBe('completed');
    expect(persisted!.steps[0].summary).toContain(
      'reconciled after executor crash',
    );
  });

  it('persists uncertainty across repeated retry flags and resolves only after durable reconciliation', async () => {
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
    expect(await saveWorkflow(sessionId, orphan, store)).toBe(true);
    await clearWorkflows(sessionId);

    const reconcileWorkflowStepRun = vi.fn(async () => ({
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
      runner: { sessionId, agentLoopV2: false, emit: vi.fn() },
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
    const persisted = await getWorkflow(
      sessionId,
      orphan.id,
      durableStore,
    );
    expect(persisted).toBeDefined();
    expect(persisted!.status).toBe('failed');
    expect(persisted!.steps[0].status).toBe('failed');
    expect(persisted!.steps[0].error).toContain('outcome_unknown');
    expect(persisted!.steps[0].effectOutcome).toBe('unknown');
    expect(persisted!.steps[0].error).toContain('does not authorize');

    for (let retry = 0; retry < 2; retry++) {
      await clearWorkflows(sessionId);
      const repeated = await tool.handler({ resume_workflow_id: orphan.id, retry_failed: true }, {
        cwd: process.cwd(), projectName: 'test', runner: { sessionId, agentLoopV2: false, emit: vi.fn() },
      } as unknown as ToolContext);
      expect(repeated.isError).toBe(true);
      expect(providerChat).not.toHaveBeenCalled();
      expect((await getWorkflow(sessionId, orphan.id, durableStore))!.steps[0].effectOutcome).toBe('unknown');
    }
    expect(reconcileWorkflowStepRun).toHaveBeenCalledTimes(3);

    // A durable terminal receipt can settle the old effect; a retry flag cannot.
    reconcileWorkflowStepRun.mockResolvedValueOnce({ outcome: 'terminal', runId: 'child-run-1',
      reason: 'completed', stepStatus: 'completed', detail: 'confirmed existing work' } as never);
    await clearWorkflows(sessionId);
    const reconciled = await tool.handler({ resume_workflow_id: orphan.id, retry_failed: true }, {
      cwd: process.cwd(), projectName: 'test', runner: { sessionId, agentLoopV2: false, emit: vi.fn() },
    } as unknown as ToolContext);
    expect(reconciled.isError).toBeFalsy();
    expect(providerChat).not.toHaveBeenCalled();
    expect((await getWorkflow(sessionId, orphan.id, durableStore))!.steps[0].effectOutcome).toBeUndefined();
  });
});
