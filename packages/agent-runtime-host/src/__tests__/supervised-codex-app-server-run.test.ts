import { describe, expect, it, vi } from 'vitest';
import {
  SupervisedCodexAppServerRun,
  type EngineJsonRpcTransport,
  type OssEngineProcessFinalization,
  type OssEngineProcessLaunchRequest,
  type OssEngineProcessLaunchReceipt,
  type OssEngineProcessLease,
  type OssEngineProcessSupervisorPort,
  type OssEngineToolHostPort,
} from '../index.js';
import { dynamicToolAlias } from '../engine-bakeoff/validation.js';
import { ossAttemptSpec } from './oss-engine-support.js';

class CodexFixtureTransport implements EngineJsonRpcTransport {
  readonly sent: Readonly<Record<string, unknown>>[] = [];
  readonly #values: unknown[] = [];
  readonly #waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  #closed = false;

  constructor(
    private readonly toolAlias: string,
    private readonly crashAfterTurnStart = false,
  ) {}

  async send(message: Readonly<Record<string, unknown>>): Promise<void> {
    this.sent.push(message);
    const method = typeof message.method === 'string' ? message.method : undefined;
    const id = typeof message.id === 'number' ? message.id : undefined;
    if (method === 'initialize' && id !== undefined) {
      this.#push({ id, result: { userAgent: 'codex-fixture' } });
      return;
    }
    if (method === 'thread/start' && id !== undefined) {
      this.#push({ id, result: { thread: { id: 'thread-supervised' } } });
      return;
    }
    if (method === 'turn/start' && id !== undefined) {
      this.#push({ id, result: { turn: { id: 'turn-supervised', status: 'inProgress' } } });
      if (this.crashAfterTurnStart) {
        this.#end();
      } else {
        this.#push({
          method: 'item/tool/call',
          id: 99,
          params: {
            threadId: 'thread-supervised',
            turnId: 'turn-supervised',
            callId: 'call-supervised',
            namespace: 'codestudio',
            tool: this.toolAlias,
            arguments: { query: 'AgentRunAttempt' },
          },
        });
      }
      return;
    }
    if (message.id === 99 && !method) {
      this.#push({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-supervised',
          turnId: 'turn-supervised',
          delta: 'done',
        },
      });
      this.#push({
        method: 'turn/completed',
        params: {
          threadId: 'thread-supervised',
          turn: { id: 'turn-supervised', status: 'completed' },
        },
      });
      return;
    }
    if (method === 'thread/delete' && id !== undefined) {
      this.#push({ id, result: {} });
    }
  }

  messages(): AsyncIterable<unknown> {
    return { [Symbol.asyncIterator]: () => ({ next: () => this.#next() }) };
  }

  async close(): Promise<void> {
    this.#end();
  }

  #push(value: unknown): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  #end(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  #next(): Promise<IteratorResult<unknown>> {
    if (this.#values.length > 0) {
      return Promise.resolve({ done: false, value: this.#values.shift() });
    }
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

class FixtureSupervisor implements OssEngineProcessSupervisorPort {
  launchRequest?: OssEngineProcessLaunchRequest;
  finalizeInput?: Parameters<OssEngineProcessLease['finalize']>[0];

  constructor(
    private readonly transport: EngineJsonRpcTransport,
    private readonly source: OssEngineProcessLaunchReceipt['source'] = 'agentd_supervisor',
    private readonly finalizationStatus: OssEngineProcessFinalization['status'] = 'reaped',
  ) {}

  async launch(request: OssEngineProcessLaunchRequest): Promise<OssEngineProcessLease> {
    this.launchRequest = request;
    return this.lease(request);
  }

  lease(request: OssEngineProcessLaunchRequest): OssEngineProcessLease {
    const launchReceipt: OssEngineProcessLaunchReceipt = {
      candidate: request.candidate,
      candidateVersion: request.candidateVersion,
      protocolVersion: request.protocolVersion,
      protocolSchemaDigest: request.protocolSchemaDigest,
      attemptId: request.attemptId,
      source: this.source,
      resourceGroupId: 'group-supervised',
      processId: 42_424,
      containmentLevel: 'hard_aggregate',
      processTreeOwned: true,
      enforcedLimits: [...request.requiredEnforcedLimits],
      spawnedAt: '2026-08-04T19:00:00.000Z',
    };
    return {
      launchReceipt,
      transport: this.transport,
      finalize: async (input: Parameters<OssEngineProcessLease['finalize']>[0]) => {
        this.finalizeInput = input;
        if (this.finalizationStatus === 'ownership_retained') {
          return {
            status: 'ownership_retained' as const,
            disposition: input.disposition,
            reason: 'supervisor_reap_pending',
          };
        }
        return {
          status: 'reaped' as const,
          disposition: input.disposition,
          reapReceipt: {
            candidate: request.candidate,
            candidateVersion: request.candidateVersion,
            protocolVersion: request.protocolVersion,
            protocolSchemaDigest: request.protocolSchemaDigest,
            attemptId: request.attemptId,
            resourceGroupId: launchReceipt.resourceGroupId,
            processId: launchReceipt.processId,
            treeEmpty: true,
            exitCode: 0,
            peakMemoryBytes: 64n * 1024n * 1024n,
            reapedAt: '2026-08-04T19:00:01.000Z',
          },
        };
      },
    };
  }
}

describe('SupervisedCodexAppServerRun', () => {
  it('derives certification from bound agentd-supervisor launch and reap receipts', async () => {
    const spec = ossAttemptSpec();
    const transport = new CodexFixtureTransport(dynamicToolAlias(spec.capabilities[0]!));
    const supervisor = new FixtureSupervisor(transport);
    const invoke = vi.fn<OssEngineToolHostPort['invoke']>(async (call) => ({
      callId: call.callId,
      accepted: true,
      started: true,
      outcome: 'completed',
      contentItems: [{ type: 'inputText', text: 'indexed result' }],
    }));
    const runner = fixtureRunner(supervisor, { invoke });

    const run = await runner.run(spec, () => undefined, new AbortController().signal);

    expect(run.result.status).toBe('completed');
    expect(run.certification).toEqual({
      status: 'read_only_spike_ready',
      blockers: [],
      observations: ['dynamic_tool_api_is_experimental'],
    });
    expect(run.finalization.status).toBe('reaped');
    expect(supervisor.finalizeInput?.disposition).toBe('completed');
    expect(supervisor.launchRequest).toMatchObject({
      executable: 'D:\\tools\\codex.exe',
      workingDirectory: spec.cwd,
      environment: { SYSTEMROOT: 'C:\\Windows' },
      requiredEnforcedLimits: ['memory', 'cpu_time', 'wall_time', 'processes'],
    });
    expect(supervisor.launchRequest?.arguments).toContain('app-server');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects direct-process evidence even when a fixture claims aggregate limits', async () => {
    const spec = ossAttemptSpec();
    const transport = new CodexFixtureTransport(dynamicToolAlias(spec.capabilities[0]!));
    const supervisor = new FixtureSupervisor(transport, 'direct_process');

    const run = await fixtureRunner(supervisor).run(
      spec,
      () => undefined,
      new AbortController().signal,
    );

    expect(run.certification.status).toBe('rejected');
    expect(run.certification.blockers).toEqual(expect.arrayContaining([
      'durable_supervisor_ownership_not_proven',
      'resource_limits_not_enforced',
    ]));
  });

  it('finalizes the owned resource group when the candidate transport crashes', async () => {
    const spec = ossAttemptSpec();
    const transport = new CodexFixtureTransport(dynamicToolAlias(spec.capabilities[0]!), true);
    const supervisor = new FixtureSupervisor(transport);

    await expect(fixtureRunner(supervisor).run(
      spec,
      () => undefined,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'candidate_run_failed' });

    expect(supervisor.finalizeInput?.disposition).toBe('failed');
  });

  it('keeps certification closed while the supervisor retains physical ownership', async () => {
    const spec = ossAttemptSpec();
    const transport = new CodexFixtureTransport(dynamicToolAlias(spec.capabilities[0]!));
    const supervisor = new FixtureSupervisor(
      transport,
      'agentd_supervisor',
      'ownership_retained',
    );

    const run = await fixtureRunner(supervisor).run(
      spec,
      () => undefined,
      new AbortController().signal,
    );

    expect(run.certification.status).toBe('rejected');
    expect(run.certification.blockers).toContain('process_tree_not_reaped');
  });

  it('does not launch a process after the attempt deadline has elapsed', async () => {
    const spec = ossAttemptSpec({
      authority: {
        ...ossAttemptSpec().authority,
        deadlineAtUnixMs: 1_799_999_999_999n,
      },
    });
    const transport = new CodexFixtureTransport(dynamicToolAlias(spec.capabilities[0]!));
    const supervisor = new FixtureSupervisor(transport);
    const runner = new SupervisedCodexAppServerRun({
      supervisor,
      toolHost: {
        invoke: async () => { throw new Error('not expected'); },
      },
      executable: 'D:\\tools\\codex.exe',
      environment: { SYSTEMROOT: 'C:\\Windows' },
      resourceBudget: {
        maxMemoryBytes: 1024n,
        maxCpuTimeMs: 1_000n,
        maxWallTimeMs: 1_000n,
        maxProcesses: 1,
        maxOpenHandles: 16,
      },
      requiredEnforcedLimits: ['memory', 'cpu_time', 'wall_time', 'processes'],
      clientVersion: '0.1.0',
      clock: { now: () => new Date(1_800_000_000_000) },
    });

    await expect(runner.run(
      spec,
      () => undefined,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'attempt_deadline_elapsed' });
    expect(supervisor.launchRequest).toBeUndefined();
  });

  it('rejects case-insensitive duplicate environment variables before launch', () => {
    const spec = ossAttemptSpec();
    const transport = new CodexFixtureTransport(dynamicToolAlias(spec.capabilities[0]!));
    const supervisor = new FixtureSupervisor(transport);

    expect(() => new SupervisedCodexAppServerRun({
      supervisor,
      toolHost: {
        invoke: async () => { throw new Error('not expected'); },
      },
      executable: 'D:\\tools\\codex.exe',
      environment: { PATH: 'one', Path: 'two' },
      resourceBudget: {
        maxMemoryBytes: 1024n,
        maxCpuTimeMs: 1_000n,
        maxWallTimeMs: 1_000n,
        maxProcesses: 1,
        maxOpenHandles: 16,
      },
      requiredEnforcedLimits: ['memory', 'cpu_time', 'wall_time', 'processes'],
      clientVersion: '0.1.0',
    })).toThrow(expect.objectContaining({ code: 'candidate_environment_duplicate' }));
    expect(supervisor.launchRequest).toBeUndefined();
  });
});

function fixtureRunner(
  supervisor: OssEngineProcessSupervisorPort,
  toolHost: OssEngineToolHostPort = {
    invoke: async (call) => ({
      callId: call.callId,
      accepted: true,
      started: true,
      outcome: 'completed',
      contentItems: [{ type: 'inputText', text: 'fixture' }],
    }),
  },
): SupervisedCodexAppServerRun {
  return new SupervisedCodexAppServerRun({
    supervisor,
    toolHost,
    executable: 'D:\\tools\\codex.exe',
    environment: { SYSTEMROOT: 'C:\\Windows' },
    resourceBudget: {
      maxMemoryBytes: 1024n * 1024n * 1024n,
      maxCpuTimeMs: 60_000n,
      maxWallTimeMs: 120_000n,
      maxProcesses: 8,
      maxOpenHandles: 4096,
    },
    requiredEnforcedLimits: ['memory', 'cpu_time', 'wall_time', 'processes'],
    clientVersion: '0.1.0',
    expectedToolCalls: 1,
  });
}
