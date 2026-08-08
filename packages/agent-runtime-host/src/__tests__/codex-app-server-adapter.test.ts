import { describe, expect, it, vi } from 'vitest';
import {
  CodexAppServerAdapter,
  type OssEngineEvent,
  type OssEngineToolHostPort,
} from '../index.js';
import { dynamicToolAlias } from '../engine-bakeoff/validation.js';
import {
  ossAttemptSpec,
  ScriptedJsonRpcPeer,
  waitForRequest,
} from './oss-engine-support.js';

describe('CodexAppServerAdapter', () => {
  it('binds one attempt, executes only snapshot tools, and deletes candidate state', async () => {
    const peer = new ScriptedJsonRpcPeer();
    const spec = ossAttemptSpec();
    const capability = spec.capabilities[0]!;
    const invoke = vi.fn<OssEngineToolHostPort['invoke']>(async (call) => ({
      callId: call.callId,
      accepted: true,
      started: true,
      outcome: 'completed',
      contentItems: [{ type: 'inputText', text: 'indexed result' }],
    }));
    const events: OssEngineEvent[] = [];
    const adapter = new CodexAppServerAdapter(peer, { invoke }, {
      clientVersion: '0.1.0',
      clock: { now: () => new Date('2026-08-04T12:00:00.000Z') },
    });

    const run = adapter.run(spec, (event) => { events.push(event); }, new AbortController().signal);
    await waitForRequest(peer, 'turn/start');

    const toolResponse = await peer.serverRequest('item/tool/call', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      namespace: 'codestudio',
      tool: dynamicToolAlias(capability),
      arguments: { query: 'AgentRunAttempt' },
    });
    expect(toolResponse).toEqual({
      contentItems: [{ type: 'inputText', text: 'indexed result' }],
      success: true,
    });

    const approval = await peer.serverRequest('item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'builtin-1',
    });
    expect(approval).toEqual({ decision: 'decline' });

    await peer.serverNotification('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      delta: 'done',
    });
    await peer.serverNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' },
    });

    await expect(run).resolves.toMatchObject({
      status: 'completed',
      metrics: {
        dynamicToolCount: 1,
        toolCallCount: 1,
        deniedBuiltInRequestCount: 1,
        observedBypassToolCount: 0,
        temporaryStateDeleted: true,
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: spec.authority,
        callId: 'call-1',
        capability,
      }),
      expect.any(AbortSignal),
    );
    expect(peer.requests.find((request) => request.method === 'thread/start')).toEqual({
      method: 'thread/start',
      params: expect.objectContaining({
        approvalPolicy: 'never',
        sandbox: 'read-only',
        dynamicTools: [expect.objectContaining({ name: 'codestudio' })],
      }),
    });
    expect(peer.requests.at(-1)).toEqual({
      method: 'thread/delete',
      params: { threadId: 'thread-1' },
    });
    expect(peer.closed).toBe(true);
    expect(events.map((event) => event.kind)).toEqual([
      'engine_initialized',
      'thread_started',
      'turn_started',
      'tool_call_terminal',
      'built_in_request_denied',
      'agent_message_delta',
      'turn_terminal',
      'temporary_state_deleted',
    ]);
  });

  it('rejects tools outside the immutable attempt snapshot', async () => {
    const peer = new ScriptedJsonRpcPeer();
    const invoke = vi.fn<OssEngineToolHostPort['invoke']>();
    const adapter = new CodexAppServerAdapter(peer, { invoke }, { clientVersion: '0.1.0' });
    const run = adapter.run(ossAttemptSpec(), () => undefined, new AbortController().signal);
    await waitForRequest(peer, 'turn/start');

    await expect(peer.serverRequest('item/tool/call', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-unknown',
      namespace: 'codestudio',
      tool: 'not_authorized',
      arguments: {},
    })).rejects.toMatchObject({ rpcCode: -32602 });
    expect(invoke).not.toHaveBeenCalled();

    await peer.serverNotification('turn/completed', {
      turn: { id: 'turn-1', status: 'completed' },
    });
    await run;
  });

  it('records built-in execution as a certification blocker even in read-only sandbox', async () => {
    const peer = new ScriptedJsonRpcPeer();
    const adapter = new CodexAppServerAdapter(peer, {
      invoke: async () => { throw new Error('not expected'); },
    }, { clientVersion: '0.1.0' });
    const run = adapter.run(ossAttemptSpec(), () => undefined, new AbortController().signal);
    await waitForRequest(peer, 'turn/start');

    await peer.serverNotification('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'builtin-1', type: 'commandExecution' },
    });
    await peer.serverNotification('turn/completed', {
      turn: { id: 'turn-1', status: 'completed' },
    });

    await expect(run).resolves.toMatchObject({
      metrics: { observedBypassToolCount: 1 },
    });
  });

  it('deletes a bound temporary thread when turn startup fails', async () => {
    const peer = new ScriptedJsonRpcPeer();
    const request = peer.request.bind(peer);
    vi.spyOn(peer, 'request').mockImplementation(async (method, params) => {
      if (method === 'turn/start') throw new Error('synthetic turn startup failure');
      return request(method, params);
    });
    const adapter = new CodexAppServerAdapter(peer, {
      invoke: async () => { throw new Error('not expected'); },
    }, { clientVersion: '0.1.0' });

    await expect(adapter.run(
      ossAttemptSpec(),
      () => undefined,
      new AbortController().signal,
    )).rejects.toThrow('synthetic turn startup failure');

    expect(peer.requests.at(-1)).toEqual({
      method: 'thread/delete',
      params: { threadId: 'thread-1' },
    });
    expect(peer.closed).toBe(true);
  });

  it('interrupts the bound turn on cancellation and still deletes temporary state', async () => {
    const peer = new ScriptedJsonRpcPeer();
    const controller = new AbortController();
    const adapter = new CodexAppServerAdapter(peer, {
      invoke: async () => { throw new Error('not expected'); },
    }, { clientVersion: '0.1.0', interruptGraceMs: 1_000 });
    const run = adapter.run(ossAttemptSpec(), () => undefined, controller.signal);
    await waitForRequest(peer, 'turn/start');

    controller.abort(new Error('user_cancelled'));
    await waitForRequest(peer, 'turn/interrupt');
    await peer.serverNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'interrupted' },
    });

    await expect(run).resolves.toMatchObject({
      status: 'interrupted',
      metrics: { temporaryStateDeleted: true },
    });
    expect(peer.requests.map((request) => request.method)).toContain('turn/interrupt');
    expect(peer.requests.at(-1)?.method).toBe('thread/delete');
  });

  it('reports an ambiguous ToolHost outcome once without retrying the mutation', async () => {
    const peer = new ScriptedJsonRpcPeer();
    const invoke = vi.fn<OssEngineToolHostPort['invoke']>(async (call) => ({
      callId: call.callId,
      accepted: true,
      started: true,
      outcome: 'outcome_unknown',
      contentItems: [{ type: 'inputText', text: 'execution outcome is unknown' }],
    }));
    const spec = ossAttemptSpec();
    const adapter = new CodexAppServerAdapter(peer, { invoke }, { clientVersion: '0.1.0' });
    const run = adapter.run(spec, () => undefined, new AbortController().signal);
    await waitForRequest(peer, 'turn/start');

    await expect(peer.serverRequest('item/tool/call', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-ambiguous',
      namespace: 'codestudio',
      tool: dynamicToolAlias(spec.capabilities[0]!),
      arguments: { value: 'mutating input' },
    })).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'execution outcome is unknown' }],
      success: false,
    });
    await peer.serverNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' },
    });

    await expect(run).resolves.toMatchObject({ metrics: { toolCallCount: 1 } });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized ToolHost output before returning it to the candidate', async () => {
    const peer = new ScriptedJsonRpcPeer();
    const spec = ossAttemptSpec();
    const adapter = new CodexAppServerAdapter(peer, {
      invoke: async (call) => ({
        callId: call.callId,
        accepted: true,
        started: true,
        outcome: 'completed',
        contentItems: [{ type: 'inputText', text: 'x'.repeat(70 * 1024) }],
      }),
    }, { clientVersion: '0.1.0' });
    const run = adapter.run(spec, () => undefined, new AbortController().signal);
    await waitForRequest(peer, 'turn/start');

    await expect(peer.serverRequest('item/tool/call', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-oversized',
      namespace: 'codestudio',
      tool: dynamicToolAlias(spec.capabilities[0]!),
      arguments: {},
    })).rejects.toMatchObject({ code: 'tool_result_budget_exceeded' });
    await peer.serverNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'failed' },
    });

    await expect(run).resolves.toMatchObject({
      status: 'failed',
      metrics: { toolCallCount: 0 },
    });
  });
});
